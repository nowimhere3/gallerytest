# hls.js 1.7.3

`hls.mjs` is the unmodified `dist/hls.min.mjs` from the official npm
[`hls.js@1.7.3`](https://registry.npmjs.org/hls.js/1.7.3) tarball, distributed
under the included Apache-2.0 LICENSE. Its same-origin relative module URL works
in Codespaces and GitHub Pages project subdirectories without a build step or
runtime CDN dependency. The adapter loads it only when native HLS is unavailable.

- Release: https://github.com/video-dev/hls.js/releases/tag/v1.7.3
- API: https://github.com/video-dev/hls.js/blob/v1.7.3/docs/API.md
- Tarball: https://registry.npmjs.org/hls.js/-/hls.js-1.7.3.tgz
- Verified npm integrity: `sha512-MsPlx6yVW4Qv4C7mEVou4/gk/5cN2dVxOTnrNjPSmyH2f0Ln+/UkG10Ax1PE6OvrmTVPKgQYozTtBaPOuCzq7A==`
- SHA-256 (`hls.mjs`): `5527dccd891e4b24c269049c5097de9277b8771d93c3e6d31dea3d9e5652df6d`

V1 sets `enableWorker:false` to avoid a separate worker asset and `debug:false`
to avoid logging stream URLs. The upstream source-map comment is retained; the
source map is not needed for playback. To update, select an explicit release,
verify its npm integrity, replace the module and LICENSE, update this record,
and run the adapter, viewer and browser checks.
