# Your own film

The full-screen film behind the page is scrubbed by scroll. Out of the box it is drawn live in
the browser (the procedural peony scene). You can replace it with real footage: a rendered or
filmed clip, cut into frames by `tools/build-film.sh`. The page uses it as soon as
`film/manifest.json` exists. Delete that file and you get the procedural film back.

## 1. Make two clips

Make one continuous shot (no cuts) in two framings of the same motion:

| Clip | Shape | Size | Seen on |
| --- | --- | --- | --- |
| desktop | 16:9 landscape | 1920×1080 or larger | laptops, desktops, tablets held sideways |
| portrait | 9:16 upright | 1080×1920 or larger | phones |

A single desktop clip works on its own. Phones then crop it, which rarely looks as good.

The clip has to follow the page's five beats, in order. Each beat lands when its section is
centred on screen.

| Scroll | Section | What the shot shows |
| --- | --- | --- |
| start | Skin in full bloom | a closed, plump peony bud with dew; the plum cap of the jar just visible at its heart |
| ¼ | The flower | the petals open wide; the jar rises out of the flower, seen slightly from above |
| ½ | The cream | the camera moves in: the jar large, upright and centred, cap on, petals soft along the bottom |
| ¾ | The texture | the cap lifts straight up and drifts to the upper right; the camera climbs over the jar's top |
| end | The ritual | overhead, looking straight down into the swirl of cream, the open peony around it |

Leave room for the text:

- **Desktop:** the copy sits in the left third of the screen. Keep the subject right of centre
  (about 55–95 % across) at the start and end, and roughly centred in the middle beats.
- **Phones:** the copy sits in the top ~38 % of the screen, so keep the subject in the lower 60 %.
- Keep a pearl-pink background (`#F4E8EE`) so the film blends into the page.

What makes a good scrub clip:

- **8–15 seconds**, one steady move with no cuts or jump zooms. Scrolling slowly shows every frame.
- **No motion blur.** Every frame is shown as a still, so render or shoot with a fast shutter.
- **Constant exposure and colour**, with no flicker and no compression noise. Export at a high
  bit rate (ProRes, or H.264/H.265 at 20+ Mbit/s).
- **Use footage you own or have licensed:** your own 3D render (Blender, Cinema 4D), a
  motion-control shoot, or a clip from a generator whose terms let you publish the result.

## 2. Build the frames

You need [ffmpeg](https://ffmpeg.org/download.html) (with `ffprobe`, which comes with it).
From the site folder, run:

```sh
tools/build-film.sh --desktop renders/peony-16x9.mp4 --portrait renders/peony-9x16.mp4
```

This samples 600 frames evenly over each clip, from the first frame to the last. It writes them
as WebP (or JPEG if your ffmpeg has no WebP encoder) into `film/desktop/` and `film/portrait/`.
For phones it also writes a lighter 720 px copy (`film/portrait/lite/`), and it writes
`film/manifest.json`. At the default quality, 600 frames come to roughly 25–40 MB per clip.
Visitors don't wait for all of it: the frames download coarse-to-fine, so the whole film can be
scrubbed within seconds.

Useful options (`tools/build-film.sh --help` lists them all):

- `--frames 720`: more frames give a smoother slow scrub but a bigger download (default 600).
- `--quality 82`: WebP quality (default 78).
- `--focus-x 0.6`: where the crop sits on screens narrower than the clip. 0 is the left edge,
  0.5 the centre, 1 the right edge. Defaults: 0.6 desktop, 0.5 portrait.
- `--acts 0,2.8,5.5,8,11`: if your beats don't fall evenly through the clip, give the time in
  seconds at which the clip reaches each of the five beats. The page then lines them up with
  their sections.
- `--width 2560` / `--lite 0`: change the output width, or skip the light phone copy.

You can build each clip in its own run, for example with different options. A variant you don't
rebuild stays in the manifest as long as its folder is still there.

## 3. How the page picks it up

`assets/js/config.js` has the setting:

```js
film: { source: "auto", manifest: "film/manifest.json", scene: "scene2d" }
```

- `"auto"` (the default) plays your frames when `film/manifest.json` exists and is valid, and
  the procedural scene otherwise. It also falls back to the procedural scene if the frames can't
  be loaded.
- `"frames"` always tries your frames first; `"scene"` ignores them.

Laptops get the desktop frames; phones (and any screen taller than it is wide) get the
portrait frames. To check the result, scroll the site, or open `dev/engine-frames.html`. It plays
`film/manifest.json` over plain test sections and shows a readout of the frame on screen.

If your host caches files forever (`Cache-Control: immutable`), returning visitors keep the old
frames after a re-render. Build into a new folder instead (`--out film-v2`) and point
`manifest` at `film-v2/manifest.json`.

## 4. Going back to the procedural film

Delete `film/manifest.json`. You can also delete the `desktop/` and `portrait/` folders to
drop the frames from the site. This README is the only file the folder needs.
