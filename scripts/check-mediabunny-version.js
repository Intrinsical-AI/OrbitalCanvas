import { readFileSync } from 'node:fs';

const { version } = JSON.parse(
  readFileSync(new URL('../node_modules/mediabunny/package.json', import.meta.url), 'utf8')
);
if (version !== '1.51.0') {
  throw new Error(
    `Mediabunny ${version} requires explicit review of patches/mediabunny+1.51.0.patch and the native cleanup regression before changing the pinned version.`
  );
}
