/**
 * graasp-websockets
 *
 * Channels and broadcast abstractions on top of the ws library
 *
 * @author Alexandre CHAU
 */
import WebSocket from 'ws';
import { Logger } from './interfaces/logger';
import { MessageSerializer } from './interfaces/message-serializer';

/**
 * Represents a WebSocket channel which clients can subscribe to
 * @member name Name of the channel
 * @member subscribers Subscribers to the channel
 * @member removeIfEmpty whether this channel will eventually be garbage collected when empty
 */
class Channel<ServerMessageType> {
  readonly name: string;
  readonly subscribers: Set<WebSocket>;
  readonly removeIfEmpty: boolean;

  constructor(name: string, removeIfEmpty: boolean) {
    this.name = name;
    this.subscribers = new Set();
    this.removeIfEmpty = removeIfEmpty;
  }

  send(
    message: ServerMessageType,
    sendFn: (client: WebSocket, msg: ServerMessageType) => boolean,
  ) {
    let ret = true;
    this.subscribers.forEach((sub) => {
      ret = ret && sendFn(sub, message);
    });
    return ret;
  }
}

/**
 * Represents a client connected to this server
 * @member ws WebSocket of this client connection
 * @member subscriptions Channels to which this client is subscribed to
 * @member isAlive Boolean that indicates if this client is still connected
 */
class Client<ServerMessageType> {
  readonly ws: WebSocket;
  readonly subscriptions: Set<Channel<ServerMessageType>>;
  isAlive: boolean;

  constructor(ws: WebSocket) {
    this.ws = ws;
    this.subscriptions = new Set();
    this.isAlive = true;

    // on heartbeat response, keep alive
    this.ws.on('pong', (data) => {
      this.isAlive = true;
    });
  }

  /**
   * Cleanup when removing this client
   * MUST be called when the client closes
   */
  close() {
    this.ws.removeEventListener('pong');
  }
}

/**
 * Channels abstraction over WebSocket server
 * Logic to handle clients and channels
 */
class WebSocketChannels<ClientMessageType, ServerMessageType> {
  // Underlying WebSocket server
  wsServer: WebSocket.Server;
  // Collection of existing channels, identified by name for lookup
  channels: Map<string, Channel<ServerMessageType>>;
  // Collection of all client subscriptions, identified by client for lookup
  subscriptions: Map<WebSocket, Client<ServerMessageType>>;
  // Serialization / Deserialization object instance
  serdes: MessageSerializer<ClientMessageType, ServerMessageType>;
  // Heartbeat interval instance
  heartbeat: NodeJS.Timeout;

  /**
   * Creates a new WebSocketChannels instance
   * @param wsServer Underlying WebSocket.Server
   * @param serdes Message serializer/desserializer for this specific server channels abstraction
   * @param log Logger output for info, error, debug, ... messages
   * @param heartbeatInterval Time interval in ms between heartbeat checks for lost connections,
   *                          MUST be at least an order of magnitude higher than network RTT
   */
  constructor(
    wsServer: WebSocket.Server,
    serdes: MessageSerializer<ClientMessageType, ServerMessageType>,
    log: Logger = console,
    heartbeatInterval: number = 30000,
  ) {
    this.wsServer = wsServer;
    this.serdes = serdes;
    this.channels = new Map();
    this.subscriptions = new Map();

    // checks lost connections every defined time interval
    this.heartbeat = setInterval(() => {
      // find clients that are not registered anymore
      this.wsServer.clients.forEach((ws) => {
        if (this.subscriptions.get(ws) === undefined) {
          log.info(
            `graasp-websockets: ejecting client ${ws.url}, orphan without subscriptions`,
          );
          ws.terminate();
        }
      });
      // find registered clients that lost connection
      this.subscriptions.forEach((client, ws) => {
        // if client was already marked dead, terminate its connection
        if (client.isAlive === false) {
          // remove from this instance also
          this.clientRemove(ws);
          log.info(
            `graasp-websockets: ejecting client ${ws.url}, timeout detected`,
          );
          return ws.terminate();
        }

        // mark all as dead and then send ping
        // (which will set them alive again when pong response is received in {@link Client})
        client.isAlive = false;
        ws.ping();
      });
      // find empty channels eligible for garbage collection
      this.channels.forEach((channel, name) => {
        if (channel.removeIfEmpty && channel.subscribers.size === 0) {
          this.channelDelete(name);
          log.info(
            `graasp-websockets: removing channel "${name}" with removeIfEmpty=${channel.removeIfEmpty}: no subscribers left on this instance`,
          );
        }
      });
    }, heartbeatInterval);

    // cleanup if server closes
    this.wsServer.on('close', () => {
      clearInterval(this.heartbeat);
    });
  }

  /**
   * Helper to send a message to a websocket client from this server
   * @param client WebSocket client to send to
   * @param message ServerMessage to transmit
   */
  clientSend(client: WebSocket, message: ServerMessageType): boolean {
    if (client.readyState !== WebSocket.OPEN) {
      return false;
    } else {
      const serialized = this.serdes.serialize(message);
      client.send(serialized);
      return true;
    }
  }

  /**
   * Registers a new client into the channels system
   * @param ws New client to register
   */
  clientRegister(ws: WebSocket): void {
    this.subscriptions.set(ws, new Client(ws));
  }

  /**
   * Removes a client from the channels system
   * @param ws Client to remove, nothing will happen if the client is not registered
   */
  clientRemove(ws: WebSocket): boolean {
    const client = this.subscriptions.get(ws);
    if (client !== undefined) {
      client.subscriptions.forEach((channel) => {
        channel.subscribers.delete(ws);
      });
      client.close();
    }
    return this.subscriptions.delete(ws);
  }

  /**
   * Subscribe a client to a given channel, can subscribe to many channels at once
   * @param ws client to subscribe to the channel
   * @param channelName name of the channel
   */
  clientSubscribe(ws: WebSocket, channelName: string): boolean {
    const channel = this.channels.get(channelName);
    if (channel !== undefined) {
      channel.subscribers.add(ws);
      const client = this.subscriptions.get(ws);
      if (client !== undefined) {
        client.subscriptions.add(channel);
        return true;
      }
    }
    return false;
  }

  /**
   * Subscribe a client to a single given channel, removes all prior subscriptions from this client
   * @param ws client to subscribe to the channel
   * @param channelName name of the channel
   */
  clientSubscribeOnly(ws: WebSocket, channelName: string): boolean {
    const client = this.subscriptions.get(ws);
    if (client !== undefined) {
      client.subscriptions.forEach((channel) => {
        channel.subscribers.delete(ws);
        client.subscriptions.delete(channel);
      });
    }
    return this.clientSubscribe(ws, channelName);
  }

  /**
   * Unsubscribe a client from a previously given subscribed channel
   * @param ws client to unsubscribe from channel
   * @param channelName name of the channel
   */
  clientUnsubscribe(ws: WebSocket, channelName: string): boolean {
    const channel = this.channels.get(channelName);
    if (channel !== undefined) {
      channel.subscribers.delete(ws);
      const client = this.subscriptions.get(ws);
      if (client !== undefined) {
        return client.subscriptions.delete(channel);
      }
    }
    return false;
  }

  /**
   * Create a new channel given a channel name
   * @param channelName name of the new channel
   * @param removeIfEmpty whether this channel will eventually be garbage collected when empty
   */
  channelCreate(channelName: string, removeIfEmpty: boolean): void {
    const channel = new Channel<ServerMessageType>(channelName, removeIfEmpty);
    this.channels.set(channelName, channel);
  }

  /**
   * Delete a channel given its name
   * @param channelName name of the channel
   * @param onlyIfEmpty remove the channel only if it has no subscribers anymore AND
   *                    its removeIfEmpty flag is set to true
   */
  channelDelete(channelName: string, onlyIfEmpty: boolean = false): boolean {
    const channel = this.channels.get(channelName);
    if (channel !== undefined) {
      // don't remove if onlyIfEmpty set but channel is not flagged, or it still has subscribers
      if (
        onlyIfEmpty &&
        (!channel.removeIfEmpty || channel.subscribers.size !== 0)
      ) {
        return false;
      }

      channel.subscribers.forEach((sub) => {
        const client = this.subscriptions.get(sub);
        if (client !== undefined) {
          client.subscriptions.delete(channel);
        }
      });
      return this.channels.delete(channelName);
    }
    return false;
  }

  /**
   * Send a message on a given channel
   * @param channelName name of the channel to send a message on
   */
  channelSend(channelName: string, message: ServerMessageType): boolean {
    const channel = this.channels.get(channelName);
    if (channel !== undefined) {
      return channel.send(message, (client, message) =>
        this.clientSend(client, message),
      );
    }
    return false;
  }

  /**
   * Sends an object message to all connected clients
   * @param message Object to broadcast to everyone
   */
  broadcast(message: ServerMessageType): boolean {
    let ret = true;
    this.wsServer.clients.forEach((client) => {
      ret = ret && this.clientSend(client, message);
    });
    return ret;
  }
}

export { WebSocketChannels };
