# Third-party notices

## vendor/tf2lzham/tf2lzham.wasm

LZHAM alpha8 as modified for Titanfall 2 VPKs, compiled to WebAssembly by pg9182/tf2lzham
(revision in `vendor/tf2lzham/REVISION`). MIT License, copyright (c) 2022 pg9182; the license text
is `vendor/tf2lzham/LICENSE`. LZHAM itself is MIT-licensed, copyright (c) 2009-2011 Richard Geldreich, Jr.

## src/binka.ts

A TypeScript port of FFmpeg's Bink Audio demuxer and decoder (libavformat/binka.c, libavcodec/binkaudio.c
at n7.1), used to decode the voice sample. That file is licensed under the GNU Lesser General Public License
version 2.1 or later, copyright (c) 2007-2011 Peter Ross, (c) 2009 Daniel Verkamp, (c) 2021 Paul B Mahol;
the license text is https://www.gnu.org/licenses/old-licenses/lgpl-2.1.html. The rest of the package is MIT.

## GPT-SoVITS

`src/sovits/` is the download, server and synthesis code of cortico-world-gpt-sovits-for-coopanion (same author,
MIT) at 2ccc36a. The GPT-SoVITS runtime (RVC-Boss/GPT-SoVITS, MIT) and its pretrained weights are not in this
package: they are downloaded on request from the sources pinned in `src/sovits/catalog.ts`.

## npm dependencies

| Package | License |
|---|---|
| audify | MIT |
| koffi | MIT |
| jpeg-js | BSD-3-Clause |
| opencc-js | MIT AND Apache-2.0 |

## Titanfall 2

No file of the game ships in this package. At run time the World reads the player's own copy of
the game: the dialogue script it patches, the subtitle table, and the voice line used as the
VoxCPM2 reference. The Miles bank layout follows LegionPlus (r-ex/LegionPlus, GPL-3.0); no
LegionPlus code is included.
