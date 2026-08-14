/**
 * A minimal CookieJar sufficient for the Intesis cloud (session cookies only).
 */
export class CookieJar {
  private cookies = new Map<string, string>();

  public setFromResponse(setCookieHeader: string | string[] | undefined): void {
    if (!setCookieHeader) {
      return;
    }
    const parts = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
    for (const part of parts) {
      const first = part.split(';', 1)[0];
      const eq = first.indexOf('=');
      if (eq === -1) {
        continue;
      }
      const name = first.slice(0, eq).trim();
      const value = first.slice(eq + 1).trim();
      if (!name) {
        continue;
      }
      this.cookies.set(name, value);
    }
  }

  public getCookieHeader(): string {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  public clear(): void {
    this.cookies.clear();
  }
}
