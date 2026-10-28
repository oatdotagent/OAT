// Single source of truth for picture and sound: every cue below drives both.
export const FPS = 30;
export const DURATION = 15;
export const W = 1920;
export const H = 1080;

export const T = {
  auroraIn: [0, 2.6], // fade up from black (pad swells in)
  dots: [2.4, 2.9, 3.4], // three nodes pop in (one bell each)
  lines: [3.8, 4.7], // connections draw (shimmer sweep)
  wordmark: 5.0, // "OAT" lands (first impact, chord change)
  tagline1: 6.6, // "Coordinate AI providers." (soft chime)
  tagline2: 7.6, // "Verify what comes back." (soft chime)
  taglineOut: 9.2, // tagline clears while the riser builds
  riser: [8.9, 10.5],
  comingSoon: 10.5, // main impact + resolution to the home chord
  fadeOut: [13.2, 15],
};
