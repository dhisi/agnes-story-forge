/**
 * Panel layout + speech balloons.
 *
 * Two things the storyboard writer now decides per script line, appended to its
 * picture prompt as a strict machine-readable tail:
 *
 *   ... prompt body ... || FRAMES: 2 || BEATS: 1) ... ; 2) ... || DIALOGUE: 1) Ravi: "Run!" ; 2) NONE
 *
 * FRAMES is how many comic frames that ONE timestamp is drawn as. It follows
 * the timestamp's own length and its own number of story beats, so a short
 * timestamp stays a single frame and no frame is ever padded in to fill a grid.
 *
 * DIALOGUE is the spoken line translated into short, natural ENGLISH, which the
 * image model letters into a proper speech balloon. Lines with no speech get
 * NONE and stay wordless.
 *
 * The tail is parsed off before the prompt body is sanitised (the sanitiser
 * deliberately removes every mention of text and balloons from the body, since
 * only this module is allowed to ask for lettering).
 */

export type Bubble = {
  /** Who speaks, when the writer named them. */
  speaker: string;
  /** Short English line to letter, already translated. */
  text: string;
};

export type PanelPlan = {
  /** The picture prompt with the tail removed. */
  body: string;
  /** 1 to 4. */
  frames: number;
  /** One short sub-action per frame (only for multi-frame timestamps). */
  beats: string[];
  /** One entry per frame; an empty text means that frame is silent. */
  bubbles: Bubble[];
};

export const MAX_FRAMES = 4;

/**
 * Frame budget from the timestamp's own duration. This is a CEILING, never a
 * target: the writer may always ask for fewer, and a timestamp with one beat
 * stays one frame however long it is.
 */
export function frameCeiling(durationSeconds: number): number {
  const d = Number.isFinite(durationSeconds) ? durationSeconds : 0;
  if (d < 5) return 1;
  if (d < 9) return 2;
  if (d < 15) return 3;
  return MAX_FRAMES;
}

const SPLIT = /\|\|/;

function splitList(raw: string): string[] {
  // "1) first ; 2) second" -> ["first", "second"]
  const parts = raw
    .split(/\s*;\s*|\s*\|\s*/)
    .map((p) => p.replace(/^\s*(?:frame\s*)?\d+\s*[).:-]\s*/i, "").trim())
    .filter((p) => p.length > 0);
  return parts;
}

function parseBubble(raw: string): Bubble {
  const value = raw.trim();
  if (!value || /^none$|^silent$|^-$/i.test(value)) return { speaker: "", text: "" };
  // Ravi: "Run now!"  |  Ravi says: Run now!  |  "Run now!"
  const m = /^([^:"'“”]{1,40}?)\s*(?:says?)?\s*:\s*(.+)$/.exec(value);
  const speaker = m ? m[1]!.trim() : "";
  const spoken = (m ? m[2]! : value).trim().replace(/^["'“”]+|["'“”]+$/g, "").trim();
  if (!spoken || /^none$/i.test(spoken)) return { speaker: "", text: "" };
  // Balloons hold a line, not a paragraph.
  const words = spoken.split(/\s+/);
  const clipped = words.length > 14 ? `${words.slice(0, 14).join(" ")}` : spoken;
  return { speaker, text: clipped.replace(/\s+/g, " ") };
}

/**
 * Reads the writer's tail off a prompt. A prompt without a tail (older cached
 * prompts, repairs, manual edits) is simply a silent single frame — exactly how
 * this app behaved before, so nothing breaks.
 */
export function parsePanelPlan(written: string, durationSeconds?: number): PanelPlan {
  const pieces = written.split(SPLIT);
  const body = (pieces[0] ?? written).trim();
  let frames = 1;
  let beats: string[] = [];
  let bubbles: Bubble[] = [];

  for (const piece of pieces.slice(1)) {
    const m = /^\s*([A-Za-z ]+?)\s*:\s*([\s\S]*)$/.exec(piece);
    if (!m) continue;
    const key = m[1]!.trim().toUpperCase();
    const value = m[2]!.trim();
    if (key === "FRAMES") {
      const n = Number.parseInt(value.replace(/\D+/g, ""), 10);
      if (Number.isFinite(n)) frames = n;
    } else if (key === "BEATS") {
      beats = splitList(value);
    } else if (key === "DIALOGUE") {
      bubbles = splitList(value).map(parseBubble);
    }
  }

  // Never pad: the frame count is the smallest of what the writer asked for,
  // what the duration allows, and how many beats it actually described.
  const ceiling = durationSeconds === undefined ? MAX_FRAMES : frameCeiling(durationSeconds);
  frames = Math.max(1, Math.min(frames, ceiling, MAX_FRAMES));
  if (beats.length > 0) frames = Math.min(frames, beats.length);
  if (frames === 1) beats = [];
  else beats = beats.slice(0, frames);
  bubbles = bubbles.slice(0, frames);

  return { body, frames, beats, bubbles };
}

const ORDINAL = ["first", "second", "third", "fourth"];

function layoutOf(frames: number): string {
  if (frames === 2)
    return "divided into exactly 2 equal comic frames side by side, left and right, separated by a clean thin white gutter";
  if (frames === 3)
    return "divided into exactly 3 comic frames in one row, left, middle and right, separated by clean thin white gutters";
  return "divided into exactly 4 equal comic frames in a 2x2 grid read left to right then top to bottom, separated by clean thin white gutters";
}

function balloonFor(b: Bubble, where: string): string {
  const who = b.speaker ? `${b.speaker}'s` : "the speaking character's";
  return (
    `${where} draw one clean white rounded manga speech balloon with a smooth black outline and a tail pointing to ` +
    `${who} mouth, containing ONLY this exact English text, spelled exactly, in bold upright comic lettering, ` +
    `correctly spelled and fully inside the balloon: "${b.text}"`
  );
}

/**
 * The lettering and layout instruction, appended AFTER the sanitised picture
 * prompt so it survives untouched. Returns "" for a silent single frame, which
 * keeps the old wordless behaviour byte for byte.
 */
export function panelDirective(plan: PanelPlan): string {
  const spoken = plan.bubbles.filter((b) => b.text.length > 0);
  if (plan.frames <= 1 && spoken.length === 0) return "";

  const out: string[] = [];

  if (plan.frames > 1) {
    out.push(
      `render this as ONE manga comic page ${layoutOf(plan.frames)}, every frame in the same art style, ` +
        `the same characters and the same location, showing consecutive moments of this one scene`,
    );
    plan.beats.forEach((beat, i) => {
      out.push(`the ${ORDINAL[i] ?? `frame ${i + 1}`} frame shows ${beat.replace(/\.$/, "")}`);
    });
  }

  plan.bubbles.forEach((b, i) => {
    if (!b.text) return;
    const where =
      plan.frames > 1 ? `in the ${ORDINAL[i] ?? `frame ${i + 1}`} frame,` : "in the upper area of the frame,";
    out.push(balloonFor(b, where));
  });

  if (spoken.length > 0) {
    out.push(
      "the speech balloon text is the only readable writing in the image apart from an action SFX; " +
        "no subtitles, no caption boxes, no watermark",
    );
  }

  return out.join(". ");
}
