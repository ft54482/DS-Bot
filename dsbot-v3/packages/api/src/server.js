import http from 'node:http';
import { createTaskService } from '../../service/src/index.js';
import { openStore } from '../../store/src/index.js';
import { createApp } from './app.js';
import { createSqliteServiceStore } from './store-adapter.js';

/**
 * Build an HTTP server backed by the L2 task service and the L1 SQLite store.
 *
 * `databasePath: ':memory:'` is the default so tests are isolated and touch no
 * files. Pass a real path to persist across restart (the SQLite store applies
 * its migrations on open).
 *
 * @param {object} [options]
 * @param {string} [options.databasePath]
 * @param {object} [options.sqliteStore] already-opened `packages/store` Store
 * @param {object} [options.service] already-created L2 service (overrides store)
 * @param {object} [options.store] service store contract (defaults to the SQLite adapter)
 * @param {() => number} [options.clock]
 * @param {(prefix: string) => string} [options.idFactory]
 * @param {string} [options.token] optional local API token
 * @returns {{server: http.Server, service: object, store: object, sqliteStore: object|null}}
 */
export function createApiServer({
  databasePath = ':memory:',
  sqliteStore = null,
  service = null,
  store = null,
  clock,
  idFactory,
  token = null,
} = {}) {
  let openedStore = sqliteStore;
  let serviceStore = store;

  if (!service) {
    if (!serviceStore) {
      if (!openedStore) openedStore = openStore({ path: databasePath });
      serviceStore = createSqliteServiceStore(openedStore);
    }
    service = createTaskService({ store: serviceStore, clock, idFactory });
  } else if (!serviceStore) {
    serviceStore = service.store;
  }

  const app = createApp({ service, store: serviceStore, clock, token });
  const server = http.createServer((req, res) => {
    void app(req, res);
  });

  let closed = false;
  server.api = {
    service,
    store: serviceStore,
    sqliteStore: openedStore,
    close() {
      return new Promise((resolve) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close(() => resolve());
      }).then(() => {
        if (closed) return;
        closed = true;
        openedStore?.close();
      });
    },
  };

  return { server, service, store: serviceStore, sqliteStore: openedStore };
}

/** Create and listen on a loopback ephemeral port; convenient for tests. */
export async function startApiServer(options = {}) {
  const built = createApiServer(options);
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 0;
  await new Promise((resolve, reject) => {
    const onError = (error) => {
      built.server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      built.server.off('error', onError);
      resolve();
    };
    built.server.once('error', onError);
    built.server.once('listening', onListening);
    built.server.listen(port, host);
  });
  const address = built.server.address();
  const hostname = address.address === '::' ? '127.0.0.1' : address.address;
  return {
    ...built,
    url: `http://${hostname}:${address.port}`,
    async close() {
      built.server.closeAllConnections?.();
      await built.server.api.close();
    },
  };
}
