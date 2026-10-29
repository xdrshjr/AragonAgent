/** `node:path` for the renderer: POSIX-style join/basename/dirname, enough for display. */
const split = (value: string): string[] => value.replace(/\\/g, '/').split('/').filter(Boolean);
export const sep = '/';
export const basename = (value: string): string => split(value).pop() ?? '';
export const dirname = (value: string): string => {
  const parts = split(value);
  parts.pop();
  return (value.startsWith('/') ? '/' : '') + parts.join('/');
};
export const join = (...parts: string[]): string => parts.join('/').replace(/\/+/g, '/');
export const resolve = join;
export const isAbsolute = (value: string): boolean => value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value);
export const extname = (value: string): string => {
  const name = basename(value);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot) : '';
};
export default { sep, basename, dirname, join, resolve, isAbsolute, extname };
