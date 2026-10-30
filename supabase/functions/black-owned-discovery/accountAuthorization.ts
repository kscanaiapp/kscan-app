type Actor = { id: string; isAnonymous: boolean };

/** Validate current account state after verified identity, before quota/catalog work. */
export function createDiscoveryAuthenticator(
  authenticate: (request: Request) => Promise<Actor>,
  assertActive: (actorId: string) => Promise<void>,
): (request: Request) => Promise<Actor> {
  return async (request) => {
    const user = await authenticate(request);
    // The handler rejects anonymous identities independently, without account I/O.
    if (!user.isAnonymous) await assertActive(user.id);
    return user;
  };
}
