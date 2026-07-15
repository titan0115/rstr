// effects/index.js — finalize registry after all category modules load.
(function (RSTR) {
  'use strict';
  // Exposed so ui.js's stops-bar control (gradient preview canvas + the
  // double-click-to-add-stop LUT sample) shares the EXACT same interpolation
  // as the cpu() render stage above -- one implementation, not a parallel port.
  RSTR.EFFECTS.gradientmap.buildLut = RSTR._buildGradientLut;
  RSTR.EFFECT_LIST = Object.keys(RSTR.EFFECTS).map((id) => RSTR.EFFECTS[id]);
})((window.RSTR = window.RSTR || {}));
