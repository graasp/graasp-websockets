# Adding real-time behaviour in Graasp front-end applications

You may want to add real-time interactions with the Graasp core server in your front-end application. This guide provides a step-by-step tutorial on how to either use or extend the functionalities provided by the `graasp-websockets` plugin. For server-side usage of the plugin, see [README.md](README.md).

## Exploring and using ready-to-use React hooks

If your front-end application is written in [React](https://reactjs.org/) and uses [React Query](https://react-query.tanstack.com/) to synchronize with server state, then the [graasp-query-client](https://github.com/graasp/graasp-query-client) repository already implements [hooks](https://reactjs.org/docs/hooks-intro.html) that can be readily called in your functional components.

Usually, you will combine a hook to query your data on the server core with another hook dedicated to receiving updates through a websocket channel.

The list of query hooks is available at [`graasp-query-client/src/hooks`](https://github.com/graasp/graasp-query-client/tree/main/src/hooks), while the list of websocket hooks is available here: [`graasp-query-client/src/ws/hooks.ts`](https://github.com/graasp/graasp-query-client/blob/main/src/ws/hooks.ts).

### Example

The following assumes that your application already takes care of authenticating the end-user for all subsequent requests.

In this example, we would like to display the children of a folder item (as defined by the `graasp` core) and automatically re-render the user interface when updates of children items (e.g additions and deletions from other users) are received, so that the end-user always sees a view that is consistent with the current state on the server.

First install the `graasp-query-client` dependency in your package.json:

```json
"dependencies": {
    "@graasp/query-client": "git://github.com/graasp/graasp-query-client.git",
}

```

And then run `npm install` (or `yarn install` depending on your package manager).

Make sure to provide the query client somewhere near the top of your components tree ([docs](https://react-query.tanstack.com/reference/QueryClientProvider)).

Call the corresponding query call in your component, and use it to display the children items. We assume the folder item ID is passed as a prop (`folderId`) to the component:

```jsx
import { hooks } from '@graasp/query-client';

const FolderView = ({ folderId }) => {
  const { data, isLoading } = hooks.useChildren(folderId);

  if (isLoading) {
    return <div>Loading children...</div>;
  }

  return (
    <div>
      {data.map((item) => (
        <a>{item.name}</a>
      ))}
    </div>
  );
};
```

The `useChildren` hook will take care of re-rendering the component by itself when `data` is actually available.

Now subscribe to children item updates by importing the `ws` object and calling `useChildrenUpdates` of its `hooks` property. With this hook, the view will automatically re-render to display these updates (as the query client will be mutated, which in turn causes a re-render).

```jsx
import { hooks, ws } from '@graasp/query-client'; // <- import ws

const FolderView = ({ folderId }) => {
  const { data, isLoading } = hooks.useChildren(folderId);
  ws.hooks.useChildrenUpdates(folderId); // <- add this line

  if (isLoading) {
    return <div>Loading children...</div>;
  }

  return (
    <div>
      {data.map((item) => (
        <a>{item.name}</a>
      ))}
    </div>
  );
};
```

That's it!

## Extending the `graasp-websockets` plugin

The existing hooks may not provide the functionality required by your application. This section will describe how to extend the capabilities of the plugin as well as of the query client.

### 1. Designing and extending the API

Make sure to read the Graasp websocket protocol specification at [API.md](API.md), which defines the messages exchanged between the server plugin and clients. If your desired event is already defined in the API, you can skip to step 2 and use the corresponding existing server message. Otherwise chances are that you need a new custom event message.

First define the semantics of your event by **editing [API.md#channels](API.md#channels)**. You need to decide on:

- The channel name (you may want to reuse an existing channel and augment through the properties below, or create a new family of channels altogether)

- The message body

  - You may want to use the schema already defined for existing channels. For instance, messages sent on an `Item` channel already define the `entity`, event `kind` and `op` action properties, on which you can enrich the domain of possible values to extend the different kinds of events related to the given entity.
  - You may want to mimic and add a similar schema (e.g. for another entity type)
  - Otherwise you can define your own custom body, depending on your custom front-end needs

- Do not break API compatibility! Your changes should not affect any message already defined

> Example: assume we want to add a new event kind called "bar" on the channel for children items which can carry actions `create`, `delete` and `foo`. Then modify [API.md](API.md) as follows:
>
> ````diff
>  - `Item` channel (from the [Item](https://github.com/graasp/graasp-types/blob/master/services/items/interfaces/item.d.ts) Graasp type)
>    - Channel name: ID of the item (= value of `item.id`) to observe
>    - Update message shape:
>        ```jsonc
>        {
>            "realm": "notif",
>            "type": "update",
>            "channel": "<itemId>",
>            "body": {
>                "entity": "item",
>                "kind": "<eventKind>",
>                "op": "<operation>",
>                "value": "<opValue>",
>            }
>        }
>        ```
>        where
>        - `<eventKind>` is:
>            - `childItem` to represent updates of the children of the current item
> +          - `bar` to represent the bar event (describe it here)
>        - `<operation>` is `create` or `delete`, applied to the `<opValue>` as a child of the current item.
> +         If the event kind is `bar`, then `<operation>` can also be `foo` which performs the foo operation (describe it here)
>        - `<opValue>` is the child item value
>    - Notes:
>        - The client must have at least read access to the item, otherwise an `ACCESS_DENIED` error response is sent>
> ````

Once you have modified the API with your newly designed message shape, translate it into a Typescript interface in [`src/interfaces/message.ts`](src/interfaces/message.ts). Make sure to integrate it with the existing class hierarchy, and use [`src/interfaces/constants.ts`](src/interfaces/constants.ts) to define any constant string. You will also need to change the corresponding [JTD schema](https://ajv.js.org/json-type-definition.html) accordingly to mirror your interface changes (see [API.md#server-specific-rules](API.md#server-specific-rules)) in [`src/schemas/message-schema.ts`](src/schemas/message-schema.ts).

You will most probably implement a change where you either:

- **extend the operations for a given channel event kind** (e.g. you may want to add possible action values for the `childItem` or `sharedWith` event).

  > For instance, say we want to add a new operation "foo" on the items channel with "childItem" event kind.
  > Then simply add the following in [`src/interfaces/constants.ts`](src/interfaces/constants.ts):
  >
  > ```diff
  >   export const WS_UPDATE_OP_CREATE = 'create';
  >   export const WS_UPDATE_OP_DELETE = 'delete';
  > + export const WS_UPDATE_OP_FOO = 'foo';
  >
  >   export type ChildItemOperation =
  >     | typeof WS_UPDATE_OP_CREATE
  >     | typeof WS_UPDATE_OP_DELETE
  > +   | typeof WS_UPDATE_OP_FOO;
  > ```
  >
  > The corresponding change in [`src/schemas/message-schema.ts`](src/schemas/message-schema.ts) is thus:
  >
  > ```diff
  > ...
  >     properties: {
  >       kind: { enum: ['childItem'] },
  > -     op: { enum: ['create', 'delete'] },
  > +     op: { enum: ['create', 'delete', 'foo'] },
  >     },
  > ...
  > ```

- **add an event `kind`** which represents a new category of events that may happen for a specific channel.

  > E.g. we want to add a new event kind called "bar" on the channel for items which can carry actions `create`, `delete` and `foo`.
  >
  > Define the event kind string name, add the operation name as well as the operation union for this event kind in [`src/interfaces/constants.ts`](src/interfaces/constants.ts):
  >
  > ```diff
  >   export const WS_UPDATE_KIND_CHILD_ITEM = 'childItem';
  >   export const WS_UPDATE_KIND_SHARED_WITH = 'sharedWith';
  > + export const WS_UPDATE_KIND_BAR = 'bar';
  >
  >   ...
  >
  >   export const WS_UPDATE_OP_CREATE = 'create';
  >   export const WS_UPDATE_OP_DELETE = 'delete';
  > + export const WS_UPDATE_OP_FOO = 'foo';
  >
  >   export type ChildItemOperation =
  >     | typeof WS_UPDATE_OP_CREATE
  >     | typeof WS_UPDATE_OP_DELETE;
  >
  >   ...
  >
  > + export type BarOperation =
  > +   | typeof WS_UPDATE_OP_CREATE
  > +   | typeof WS_UPDATE_OP_DELETE
  > +   | typeof WS_UPDATE_OP_FOO;
  > ```
  >
  > Then create a new interface for this event kind after the existing interfaces for this entity, and add it to the body union type of this entity in [`src/interfaces/message.ts`](src/interfaces/message.ts):
  >
  > ```diff
  >   /**
  >    * Update body type for Item channels
  >    */
  >   type ItemUpdateBody = ItemChildUpdateBody
  > +   | ItemBarUpdateBody;
  >
  >   interface ItemChildUpdateBody {
  >     entity: typeof WS_ENTITY_ITEM;
  >     kind: typeof WS_UPDATE_KIND_CHILD_ITEM;
  >     op: ChildItemOperation;
  >     value: any; // should be Item, workaround for JTD schema
  >   }
  >
  > + interface ItemBarUpdateBody {
  > +   entity: typeof WS_ENTITY_ITEM;
  > +   kind: typeof WS_UPDATE_KIND_BAR;
  > +   op: BarOperation;
  > +   value: any; // should be Item, workaround for JTD schema
  > + }
  > ```
  >
  > Also create a factory for external creation of this update kind at the bottom of the file:
  >
  > ```diff
  > + export const createBarUpdate = (
  > +   itemId: string,
  > +   op: ItemBarUpdateBody['op'],
  > +   item: Item,
  > + ): ServerUpdate =>
  > +   createServerUpdate(itemId, {
  > +     entity: WS_ENTITY_ITEM,
  > +     kind: WS_UPDATE_KIND_BAR,
  > +     op,
  > +     value: item,
  > +   });
  > ```
  >
  > You will then need to modify the JTD schema accordingly in [`src/schemas/message-schema.ts`](src/schemas/message-schema.ts). In this case since the `op` field is augmented with `foo` only when `kind` is `bar`, we need to discriminate against the `kind` field so that each event kind has a distinct operations set (however if your event kind has the same set of operations as the existing ones, you can simply add the event kind name to the kind enum array as `kind: { enum: ['childItem', 'bar'] }`):
  >
  > ```diff
  > ...
  >     item: {
  > -     properties: {
  > -       kind: { enum: ['childItem'] },
  > -       op: { enum: ['create', 'delete'] },
  > -     },
  > -     optionalProperties: {
  > -       value: {},
  > -     },
  > +     discriminator: 'kind',
  > +     mapping: {
  > +       childItem: {
  > +         properties: {
  > +           op: { enum: ['create', 'delete'] },
  > +         },
  > +         optionalProperties: {
  > +           value: {},
  > +         }
  > +       },
  > +       bar: {
  > +         properties: {
  > +           op: { enum: ['create', 'delete', 'foo'] },
  > +         },
  > +         optionalProperties: {
  > +           value: {},
  > +         }
  > +       }
  > +     }
  >     }
  > ...
  > ```

- **add an `entity` type**: when you want to add notifications for a new entity (for instance related to a different object in the database)

  > E.g. we want to add notifications for an entity `Baz` which can emit events of kind `bar`, with operation `foo`.
  >
  > First define the associated constants in [`src/interfaces/constants.ts`](src/interfaces/constants.ts):
  >
  > ```diff
  >   export const WS_ENTITY_ITEM = 'item';
  >   export const WS_ENTITY_MEMBER = 'member';
  > + export const WS_ENTITY_BAZ = 'baz';
  >
  >   export type EntityName =
  >     | typeof WS_ENTITY_ITEM
  >     | typeof WS_ENTITY_MEMBER
  > +   | typeof WS_ENTITY_BAZ;
  >
  >   ...
  >
  >   export const WS_UPDATE_KIND_CHILD_ITEM = 'childItem';
  >   export const WS_UPDATE_KIND_SHARED_WITH = 'sharedWith';
  > + export const WS_UPDATE_KIND_BAR = 'bar';
  >
  >   export const WS_UPDATE_OP_CREATE = 'create';
  >   export const WS_UPDATE_OP_DELETE = 'delete';
  > + export const WS_UPDATE_OP_FOO = 'foo';
  >
  >   ...
  >
  > + export type BarOperation =
  > +   | typeof WS_UPDATE_OP_FOO;
  > ```
  >
  > In [`src/interfaces/message.ts`](src/interfaces/message.ts) create a new interface and a new type for the update body of this entity. Then add this type to the body union type of the `ServerUpdate` interface. Also add a factory method to create your event messages:
  >
  > ```diff
  >   ...
  >
  >   export interface ServerUpdate extends Message {
  >     type: typeof WS_SERVER_TYPE_UPDATE;
  >     channel: string;
  > -   body: ItemUpdateBody | MemberUpdateBody;
  > +   body: ItemUpdateBody | MemberUpdateBody | BazUpdateBody;
  >   }
  >
  >   ...
  >
  > + /**
  > +  * Update body type for Baz channels
  > +  */
  > + type BazUpdateBody = BazBarUpdateBody;
  > +
  > + interface BazBarUpdateBody {
  > +   entity: typeof WS_ENTITY_BAZ;
  > +   kind: typeof WS_UPDATE_KIND_BAR;
  > +   op: BarOperation;
  > +   value: any; // should be Baz, workaround for JTD schema
  > +  }
  >
  >   ...
  >
  > + export const createBarUpdate = (
  > +   bazId: string,
  > +   op: BazBarUpdateBody['op'],
  > +   baz: Baz,
  > + ): ServerUpdate =>
  > +   createServerUpdate(bazId, {
  > +     entity: WS_ENTITY_BAZ,
  > +     kind: WS_UPDATE_KIND_BAR,
  > +     op,
  > +     value: baz,
  > +   });
  > ```
  >
  > Mimic these interface changes in the JTD schema at [`src/schemas/message-schema.ts`](src/schemas/message-schema.ts):
  >
  > ```diff
  >   ...
  >
  >     body: {
  >       discriminator: 'entity',
  >       mapping: {
  >         item: {
  >           properties: {
  >             kind: { enum: ['childItem'] },
  >             op: { enum: ['create', 'delete'] },
  >           },
  >           optionalProperties: {
  >             value: {},
  >           },
  >         },
  >         member: {
  >           properties: {
  >             kind: { enum: ['sharedWith'] },
  >             op: { enum: ['create', 'delete'] },
  >           },
  >           optionalProperties: {
  >             value: {},
  >           },
  >         },
  > +       baz: {
  > +         properties: {
  > +           kind: { enum: ['bar'] },
  > +           op: { enum: ['foo'] },
  > +         },
  > +         optionalProperties: {
  > +           value: {},
  > +         },
  > +       },
  >       },
  >     },
  >   
  >   ... 
  > ```
  >
  > You will also need to modify the client-side messages, to allow subscriptions to this new entity. Since you already changed the `EntityName` constant export and `ClientSubscribe(Only)` is already typed against `EntityName`, you only need to change it in the [`src/schemas/message-schema.ts`](src/schemas/message-schema.ts):
  >
  > ```diff
  >   ...
  >
  >   subscribe: {
  >     properties: {
  >       realm: { enum: ['notif'] },
  >       channel: { type: 'string' },
  > -     entity: { enum: ['item', 'member'] },
  > +     entity: { enum: ['item', 'member', 'baz'] },
  >     },
  >   },
  >   unsubscribe: {
  >     properties: {
  >       realm: { enum: ['notif'] },
  >       channel: { type: 'string' },
  >     },
  >   },
  >   subscribeOnly: {
  >     properties: {
  >       realm: { enum: ['notif'] },
  >       channel: { type: 'string' },
  > -     entity: { enum: ['item', 'member'] },
  > +     entity: { enum: ['item', 'member', 'baz'] },
  >     },
  >   },
  >
  >   ...
  > ```
  >

- **something else**: you will want to dive deeper into the codebase of `graasp-websockets` and customize the interfaces as well as the logic to your new API.

### 2. Registering the message trigger in `graasp-websockets`

#### Channel access control

### 3. Client-side implementation and hooks in `graasp-query-client`

## Implementing your own client for the Graasp Websocket protocol