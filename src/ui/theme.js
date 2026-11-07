export function applyAppearance(appearance) {
  document.documentElement.dataset.theme = appearance;
  document.querySelector('meta[name="theme-color"]').content =
    appearance === 'light' ? '#ffffff' : '#000000';
}
export function colors(appearance) {
  return appearance === 'light'
    ? { background: '#ffffff', foreground: '#000000' }
    : { background: '#000000', foreground: '#ffffff' };
}
