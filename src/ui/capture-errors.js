export function cancelled() {
  return new DOMException('Recording cancelled', 'AbortError');
}

export function unavailable(message) {
  return Object.assign(new Error(message), { code: 'CAPTURE_UNAVAILABLE' });
}
