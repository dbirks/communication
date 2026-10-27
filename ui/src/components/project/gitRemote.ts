/**
 * The remote a person recognises — `github.com/example/app` — from whatever
 * shape the git URL arrives in (https, ssh, or scp-style `git@host:path`).
 *
 * The full URL stays on the row's text and `title`; only the visible line is
 * shortened, because the overview's right column is 300px and a whole URL is
 * unreadable there. Lives here (not in the page) because the repository page
 * and the project overview print the same line and must not disagree.
 */
export function gitRemote(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  const scp = /^[^@/\s]+@([^:\s]+):(.+)$/.exec(trimmed);
  if (scp) return `${scp[1]}/${scp[2]}`.replace(/\.git$/, "");
  const withoutScheme = trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  return withoutScheme.replace(/\.git$/, "");
}
