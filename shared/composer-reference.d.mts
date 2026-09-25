type ReferenceKind = "skill" | "agent";

export const COMPOSER_REFERENCE_FORMAT: "taskboard.composer-reference.v1";
export function encodeComposerReferenceKey(stableId: string): string;
export function decodeComposerReferenceKey(referenceKey: string): string;
export function readComposerReferenceId(referenceKey: string, kind?: string): string | null;
export function composerReferenceUri(kind: ReferenceKind, stableId: string): string;
export function composerReferencePersistence(kind: ReferenceKind, stableId: string, label: string): {
  format: typeof COMPOSER_REFERENCE_FORMAT;
  kind: ReferenceKind;
  referenceKey: string;
  markdown: string;
};
export function parseComposerReferenceUri(uri: string): {
  format: typeof COMPOSER_REFERENCE_FORMAT;
  kind: ReferenceKind;
  referenceKey: string;
  stableId: string;
};
