const ARTIST_IDENTITY_VERSION = 'agent-radio-artist-identity-v1-candidate.2';
const ARTIST_NAME_ORDER_PROMPT_GUARD =
  'ARTIST NAME ORDER: The supplied display artist is already normalized. Reproduce it exactly and never reverse, rotate, translate, respell, or reorder its tokens.';

const ORG = /\b(orchestra|symphony|ensemble|quartet|choir|band|trio|duo|records|radio|collective|philharmonic)\b/iu;
const NON_LATIN = /[^\u0000-\u024f\u1e00-\u1eff\s,.&;/()\-'’]/u;
const CREDIT = /\s+(?:feat\.?|ft\.?|featuring|with)\s+/iu;
const SUFFIX = /\b(?:Jr\.?|Sr\.?|II|III|IV|Ph\.?D\.?)$/iu;
const INITIALS = /^(?:[A-Z]\.){1,4}$/u;
const CULTURAL_GUARD = new Set(['Yamaguchi, Momoe', 'Kim, Min-ji']);
const REVIEWED_GIVEN = new Set(['miles','john','charlie','gabriel','ludwig','johann','alice']);
const SURNAME_PARTICLES = /^(?:van|von|de|da|del|di|du|la|le)\s/iu;
const REVIEWED_COMPOUND_SURNAMES = new Set(['garcía márquez']);

function pack(raw, display, kind, confidence, evidence, canonicalArtist=null) {
  return {rawArtist:raw, displayArtist:display, canonicalArtist,
    normalization:{version:ARTIST_IDENTITY_VERSION, kind, confidence, evidence}};
}
function positivePersonEvidence(family, given, options) {
  if (options.role === 'composer' || options.personalNameEvidence === true) return true;
  if (/\d/u.test(family) || /\d/u.test(given)) return false;
  const familyWords = family.trim().split(/\s+/u);
  const familySafe = familyWords.length === 1 || SURNAME_PARTICLES.test(family) ||
    REVIEWED_COMPOUND_SURNAMES.has(family.toLocaleLowerCase('und'));
  if (!familySafe) return false;
  const firstGiven = given.trim().split(/\s+/u)[0];
  return INITIALS.test(firstGiven) || REVIEWED_GIVEN.has(firstGiven.toLocaleLowerCase('und'));
}
function normalizeArtistIdentity(raw, options={}) {
  if (raw == null || raw === '') return pack(raw, null, 'none', 1, 'empty');
  const value=String(raw);
  const canonical=options.authoritativeCanonical;
  const source=options.authoritativeSource;
  if (canonical && (source === 'musicbrainz-canonical' || source === 'agentdj-canonical'))
    return pack(value,String(canonical),source,Number(options.confidence ?? 1),String(options.evidence ?? source),String(canonical));
  if (CULTURAL_GUARD.has(value)) return pack(value,value,'ambiguous',0,'cultural-order-review-guard');
  if (NON_LATIN.test(value)) return pack(value,value,'ambiguous',0,'non-latin-or-cultural-order');
  if (value !== value.trim() || /^[([]/u.test(value)) return pack(value,value,'ambiguous',0,'formatting-or-wrapper');
  if (value.includes(';') || /\s\/\s/u.test(value) || /\s(?:&|and)\s/iu.test(value))
    return pack(value,value,'ambiguous',0,'multi-artist-or-organization');
  const credit=CREDIT.exec(value);
  const primary=credit ? value.slice(0,credit.index).trim() : value;
  const creditSuffix=credit ? value.slice(credit.index) : '';
  if (ORG.test(primary)) return pack(value,value,'ambiguous',0,'organization-pattern');
  const commaCount=(primary.match(/,/gu)||[]).length;
  if (commaCount !== 1) return pack(value,value,commaCount?'ambiguous':'none',commaCount?0:1,commaCount?'multiple-commas':'unchanged');
  const [family,given]=primary.split(',').map(x=>x.trim());
  if (!family || !given || SUFFIX.test(given)) return pack(value,value,'ambiguous',0,'suffix-or-incomplete-comma-form');
  if (family.split(/\s+/u).length > 3 || given.split(/\s+/u).length > 5)
    return pack(value,value,'ambiguous',0,'comma-form-too-complex');
  if (!positivePersonEvidence(family,given,options))
    return pack(value,value,'ambiguous',0,'comma-credit-without-person-evidence');
  return pack(value,`${given} ${family}${creditSuffix}`,'comma-person-name',0.95,
    options.role === 'composer' ? 'explicit-comma-composer-form' : 'explicit-comma-person-form');
}
function normalizeParsedMetadata(meta, canonical={}) {
  const out={...meta};
  const artistIdentity=normalizeArtistIdentity(meta?.artist ?? null,{...(canonical.artist ?? {}),role:'artist'});
  const composerIdentity=normalizeArtistIdentity(meta?.composer ?? null,{...(canonical.composer ?? {}),role:'composer'});
  out.rawArtist=artistIdentity.rawArtist;
  out.displayArtist=artistIdentity.displayArtist;
  out.canonicalArtist=artistIdentity.canonicalArtist;
  out.artistNormalization=artistIdentity.normalization;
  out.rawComposer=composerIdentity.rawArtist;
  out.displayComposer=composerIdentity.displayArtist;
  out.canonicalComposer=composerIdentity.canonicalArtist;
  out.composerNormalization=composerIdentity.normalization;
  return out;
}

module.exports = { ARTIST_IDENTITY_VERSION, ARTIST_NAME_ORDER_PROMPT_GUARD, normalizeArtistIdentity, normalizeParsedMetadata };
