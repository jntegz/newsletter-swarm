export function testLinkKey(secret: string): string;
export const TEST_MEMBER_KEYS: string;
export function testLinkBindings(
  secrets: string[],
  options?: { memberKeys?: boolean },
): Record<string, string>;
