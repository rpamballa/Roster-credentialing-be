export async function pingActivity(name: string): Promise<string> {
  return `pong:${name}`;
}
