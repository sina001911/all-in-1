/**
 * Media gate. In the MVP, `media.enabled = false` and every media capability
 * resolves to MEDIA_DISABLED. This is enforced *before* any router, provider,
 * or cost decision is consulted, so no media call can ever occur.
 */
export const MEDIA_DISABLED_CODE = "MEDIA_DISABLED" as const;

export class MediaDisabledError extends Error {
  readonly capability: string;
  constructor(capability: string) {
    super(`Media is disabled in the MVP (media.enabled = false): ${capability}`);
    this.name = "MediaDisabledError";
    this.capability = capability;
  }
}

export interface MediaGate {
  readonly enabled: false;
  guard(capability: string): never;
}

export const mediaGate: MediaGate = {
  enabled: false,
  guard(capability: string): never {
    throw new MediaDisabledError(capability);
  },
};
