(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.AgentRadioNarrationOutputGuard = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  function normalized(text) {
    return String(text || '')
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  var HARD_RULES = [
    ['apology_refusal', /\b(?:i am|i'm) sorry\b.{0,100}\b(?:cannot|can't|unable)\b/],
    ['fulfill_request', /\b(?:cannot|can't|unable to)\s+(?:fulfill|comply with|assist with|help with)\s+(?:that|this|the|your)\s+request\b/],
    ['ai_identity', /\bas an ai(?: language model| assistant)?\b/],
    ['policy_refusal', /\b(?:i must|i have to)\s+(?:decline|refuse)\b/],
    ['capability_disclaimer', /\bi (?:do not|don't) have (?:the )?(?:ability|capability) to\b/]
  ];

  var SOFT_RULES = [
    ['insufficient_information', /\b(?:not enough|insufficient) information\b/],
    ['provided_information', /\binformation (?:provided|available|given)\b/],
    ['assistant_signoff', /\blet me know (?:how|what|if|which|whether)\b/],
    ['request_language', /\b(?:that|this|the|your) request\b/],
    ['cannot_determine', /\b(?:cannot|can't|unable to) determine\b/],
    ['who_specifically', /\bwho specifically\b/],
    ['need_more_detail', /\b(?:provide|need) (?:more|additional) (?:details|information|context)\b/]
  ];

  function detect(text) {
    var s = normalized(text);
    if (!s) return { rejected: false, rule: null, softCount: 0 };
    for (var i = 0; i < HARD_RULES.length; i++) {
      if (HARD_RULES[i][1].test(s)) {
        return { rejected: true, rule: HARD_RULES[i][0], softCount: 0 };
      }
    }
    var matched = [];
    for (var j = 0; j < SOFT_RULES.length; j++) {
      if (SOFT_RULES[j][1].test(s)) matched.push(SOFT_RULES[j][0]);
    }
    return {
      rejected: matched.length >= 2,
      rule: matched.length >= 2 ? 'soft_combination:' + matched.join(',') : null,
      softCount: matched.length
    };
  }

  return { schemaVersion: 1, detect: detect };
});
