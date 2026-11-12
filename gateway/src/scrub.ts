/** Removes the user's folder name from Windows, macOS and Linux paths. */
export function scrubUserPaths(text: string) {
  return text
    .replace(/([A-Za-z]:\\Users\\)[^\\\s"']+/g, "$1…")
    .replace(/(\/Users\/)[^\/\s"']+/g, "$1…")
    .replace(/(\/home\/)[^\/\s"']+/g, "$1…");
}
