import { env } from "@cred/config";
import { Client, Connection } from "@temporalio/client";

let connectionPromise: Promise<Connection> | undefined;
let cachedClient: Client | undefined;

async function getConnection(): Promise<Connection> {
  if (!connectionPromise) {
    connectionPromise = Connection.connect({ address: env().TEMPORAL_ADDRESS });
  }
  return connectionPromise;
}

export async function temporal(): Promise<Client> {
  if (!cachedClient) {
    const connection = await getConnection();
    cachedClient = new Client({ connection, namespace: env().TEMPORAL_NAMESPACE });
  }
  return cachedClient;
}

export async function closeTemporal(): Promise<void> {
  if (cachedClient) cachedClient = undefined;
  if (connectionPromise) {
    const conn = await connectionPromise;
    await conn.close();
    connectionPromise = undefined;
  }
}
