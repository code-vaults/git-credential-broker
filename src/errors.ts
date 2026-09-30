/**
 * A provider failure that is safe to hand to the caller.
 *
 * The broker answers the container with a generic message on purpose: provider errors can embed API
 * responses, and those can carry more than the operator meant to share. But some failures are
 * *ours*, composed from the configuration and a permission name, with nothing from GitHub's body in
 * them — "this installation has not been approved for `workflows`" is one.
 *
 * Marking those lets them through, which is the difference between a push that says "see the broker
 * log" and one that says what is missing.
 */
export class ProviderConfigError extends Error {
  /**
   * @param message - the explanation, which must contain nothing from a provider's response body.
   */
  constructor(message: string) {
    super(message);
    this.name = 'ProviderConfigError';
  }
}
