# Media runtime notices

Studio Electron and Server invokes FFmpeg as a separate process. The pinned npm dependency `ffmpeg-static` 5.3.0 downloads binary release **b6.1.1**. Its package includes the upstream README and license files; keep these with the distribution. Electron packaging unpacks the entire `node_modules/ffmpeg-static` directory.

- Binary distribution, corresponding build sources and release details: https://github.com/eugeneware/ffmpeg-static/tree/b6.1.1
- FFmpeg source and license documentation: https://ffmpeg.org/download.html and https://ffmpeg.org/legal.html
- `ffmpeg-static` package license: GPL-3.0-or-later (see the installed package LICENSE).

This is an internal development build. Before distributing a public release, include the corresponding source/build materials and notices required by the selected binary build. Do not strip these notices or imply that all bundled components use the application license.
