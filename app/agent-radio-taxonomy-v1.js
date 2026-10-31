// Agent Radio taxonomy v1 — promoted candidate.5.1, self-contained
const V4 = (() => {
const TAXONOMY_VERSION = 'agent-radio-taxonomy-v1-candidate.4';
const DISPLAY_PARENTS = Object.freeze([
  'Classical', 'Jazz', 'Blues', 'Electronic & Dance', 'Ambient & Chill',
  'Rock & Alternative', 'Metal', 'Pop & Contemporary',
  'Hip-Hop, Soul, Funk & R&B', 'Country', 'Folk & Roots',
  'Reggae & Caribbean', 'Latin', 'World & Regional',
  'Religious & Spiritual', 'News & Talk', 'Sports', 'Comedy',
  'Spoken Word & Culture', 'Decades & Oldies', 'Mixed / Variety',
  'Experimental & Avant-Garde', 'Other / Unclassified'
]);

function foldTaxonomyValue(value) {
  return String(value ?? '').normalize('NFKC').toLocaleLowerCase('und')
    .replaceAll('&', ' and ').replaceAll('؛', ' ')
    .replace(/[’'`´]/gu, '').replace(/[^\p{L}\p{N}_\s-]+/gu, ' ')
    .replaceAll('-', ' ').replace(/\s+/gu, ' ').trim();
}

const EXACT = new Map(Object.entries({
  'поп':'Pop & Contemporary','рок':'Rock & Alternative',
  'noticias':'News & Talk','informations':'News & Talk','haber':'News & Talk',
  'info':'News & Talk','news talk':'News & Talk','news and talk':'News & Talk',
  'news؛talk':'News & Talk','local news':'News & Talk','sports news':'Sports',
  'sport':'Sports','deporte':'Sports','quran':'Religious & Spiritual',
  'islamic':'Religious & Spiritual','القرآن':'Religious & Spiritual',
  'اسلامي':'Religious & Spiritual','cultura':'Spoken Word & Culture',
  'culture':'Spoken Word & Culture','cultural':'Spoken Word & Culture',
  'cultural programming':'Spoken Word & Culture','audiobooks':'Spoken Word & Culture',
  'аудиокниги':'Spoken Word & Culture','adult contempary':'Pop & Contemporary',
  'hiphop':'Hip-Hop, Soul, Funk & R&B','hip hop':'Hip-Hop, Soul, Funk & R&B',
  'deutscher hip hop':'Hip-Hop, Soul, Funk & R&B','folk music':'Folk & Roots',
  'pop music':'Pop & Contemporary','latin music':'Latin','arabic music':'World & Regional',
  'african music':'World & Regional','serbian music':'World & Regional',
  'local music':'World & Regional','middle eastern music':'World & Regional',
  'indian music':'World & Regional','bangla music':'World & Regional',
  'bengali music':'World & Regional','polish pop music':'World & Regional',
  'romanian pop':'World & Regional','russian pop':'World & Regional',
  'russian rock':'Rock & Alternative','greek pop':'Pop & Contemporary',
  'brazilian pop':'Pop & Contemporary','reggae and dub':'Reggae & Caribbean',
  'merengue bachata':'Latin','cuban music':'Latin','colombian music':'Latin',
  'mexican music':'Latin','baladas en español':'Pop & Contemporary',
  'musica en español':'Pop & Contemporary','música en español':'Pop & Contemporary',
  'deep house':'Electronic & Dance','electronica':'Electronic & Dance',
  'electro':'Electronic & Dance','dub techno':'Electronic & Dance',
  'drum and bass':'Electronic & Dance','progressive psytrance':'Electronic & Dance',
  'psytrance':'Electronic & Dance','chilled trap':'Electronic & Dance',
  'chillout':'Ambient & Chill','downtempo':'Ambient & Chill',
  'meditation':'Ambient & Chill','lounge':'Ambient & Chill','smooth jazz':'Jazz',
  'cool jazz':'Jazz','bossa nova':'Jazz','alternative rock':'Rock & Alternative',
  'classic rock':'Rock & Alternative','progressive rock':'Rock & Alternative',
  'hard rock':'Rock & Alternative','punk rock':'Rock & Alternative',
  'alternative metal':'Metal','death metal':'Metal','heavy metal':'Metal',
  'classic country':'Country','classic':'Decades & Oldies',
  'classic hits':'Decades & Oldies','golden oldies':'Decades & Oldies',
  'goldies':'Decades & Oldies','evergreens':'Decades & Oldies',
  '50s':'Decades & Oldies','60s':'Decades & Oldies','70s':'Decades & Oldies',
  '80s':'Decades & Oldies','90s':'Decades & Oldies','00s':'Decades & Oldies',
  '1970s':'Decades & Oldies','1980s':'Decades & Oldies',
  '2000s':'Decades & Oldies','80er':'Decades & Oldies','90er':'Decades & Oldies',
  '70er':'Decades & Oldies','anni 80':'Decades & Oldies','90 е':'Decades & Oldies',
  'mixed':'Mixed / Variety','mix':'Mixed / Variety','mixes':'Mixed / Variety',
  'eclectic':'Mixed / Variety','entertainment':'Mixed / Variety',
  'entretenimiento':'Mixed / Variety','generaliste':'Mixed / Variety',
  'généraliste':'Mixed / Variety','experimental':'Experimental & Avant-Garde',
  'acid':'Electronic & Dance','disco':'Electronic & Dance',
  'easy listening':'Ambient & Chill','speech':'Spoken Word & Culture',
  'chanson':'World & Regional','lollywood':'World & Regional','opm':'World & Regional',
  'anime':'World & Regional','party':'Mixed / Variety','dj':'Electronic & Dance','old time radio':'Spoken Word & Culture'
}));

const RULES = [
  ['Classical', /\b(classical|klassik|orchestr|symphon|opera|operetta|baroque|choral|renaissance|medieval)\b/u],
  ['Jazz', /\b(jazz|bebop|bop|swing|big band|fusion)\b/u],
  ['Blues', /\bblues\b/u],
  ['Experimental & Avant-Garde', /\b(experimental|avant garde|avantgarde|sound art|noise)\b/u],
  ['Ambient & Chill', /\b(ambient|chill|chillout|downtempo|lounge|lofi|drone|relax|sleep|meditation|new age|nature|zen|psybient|psychill|psydub|easy listening)\b/u],
  ['Electronic & Dance', /\b(electronic|electronica|electro|dance|house|techno|trance|psytrance|dubstep|drum and bass|edm|club|eurodance|hardstyle|breaks|synthwave|retrowave|disco)\b/u],
  ['Metal', /\b(metal|metalcore|grindcore|doom|sludge|thrash)\b/u],
  ['Rock & Alternative', /\b(rock|alternative|indie|punk|grunge|new wave|post punk|rockabilly)\b/u],
  ['Hip-Hop, Soul, Funk & R&B', /\b(hiphop|hip hop|rap|rnb|soul|funk|motown|trap)\b/u],
  ['Country', /\b(country|bluegrass)\b/u],
  ['Folk & Roots', /\b(folk|roots|celtic|fado|türkü|turku|folklore)\b/u],
  ['Reggae & Caribbean', /\b(reggae|dancehall|rocksteady|ska|caribbean)\b/u],
  ['Latin', /\b(latin|latino|salsa|bachata|merengue|cumbia|banda|mariachi|reggaeton|vallenato|ranchera|tropical|rumba|cuban)\b/u],
  ['Religious & Spiritual', /\b(christian|catholic|gospel|religious|religion|spiritual|islamic|quran|mantra|hymn|orthodox|adventista|hindu|sunnah)\b|القرآن|اسلامي/u],
  ['Sports', /\b(sport|sports|soccer|deporte|deportes)\b/u],
  ['Comedy', /\b(comedy|humor)\b/u],
  ['Spoken Word & Culture', /\b(audiobook|literature|culture|cultural|educational|drama|theatre|teatru|old time radio|spoken word|speech)\b|аудиокниги/u],
  ['News & Talk', /\b(news|talk|information|info|noticias|haber|politic|business news|public radio|npr|traffic)\b|новости|разговор/u],
  ['Decades & Oldies', /\b(1930|1940|1950|50s|60s|70s|80s|90s|00s|2000s|2010s|oldies|goldies|evergreens|classic hits|retro|vintage|80er|90er|70er|anni 80)\b|90 е/u],
  ['Pop & Contemporary', /\b(pop|top 40|top40|hits|adult contemporary|adult contempary|contemporary hits|chr|love songs|ballads|baladas|schlager|jpop|electropop|synthpop)\b/u],
  ['World & Regional', /\b(world|international|african|arabic|middle eastern|indian|bollywood|bhojpuri|bengali|bangla|dangdut|persian|armenian|serbian|croatian|greek|japanese|ethnic|regional|local music|polish|russian|brazilian|chanson|lollywood|opm|anime)\b/u],
  ['Mixed / Variety', /\b(mixed|mix|mixes|variety|variedades|eclectic|freeform|general|generaliste|music|entertainment|radio|live air|party)\b/u]
];

const TECHNICAL = /^(aac|mp3|\d+\s*kbps|\d+(?:\.\d+)?\s*(?:fm|am)?|fm|live)$/u;
const GENERIC = /^(other|misc|undefined|music|radio|anonymous|commercial|adult|best music for you|added by .+|#.*)$/u;
const GEOGRAPHIC = new Set(['africa','brasil','california','russia','india','indonesia','turkey','lithuania','iran','london','moscow','roma','yogyakarta','faroe islands','monastir','bogota','bogotá','new york city','ciudad de mexico','szczecin','cheboksary','gafsa','johannesburg','berlin','tegucigalpa','cochabamba','lviv','banja luka','south india']);
const NETWORK = new Set(['abc','ard','bbc','bnr','duna média','ert','france médias monde','ilstations','kantipur','latvijas radio','mediaset','npr','polskieradio','uab m 1','uab radijo stotis laluna','amg','acir','dorenko','laika']);

function hits(text) {
  return RULES.filter(([, re]) => re.test(text)).map(([parent]) => parent);
}
function unique(values) { return [...new Set(values)]; }
function resolve(candidates, text) {
  const c = unique(candidates);
  if (c.length <= 1) return {parent:c[0] ?? null, candidates:c, resolvedBy:c.length ? 'single-candidate' : null};
  const has = x => c.includes(x);
  if (has('Sports') && has('News & Talk')) return {parent:'Sports', candidates:c, resolvedBy:'precedence:sports-talk'};
  if (has('News & Talk') && has('Spoken Word & Culture')) return {parent:'News & Talk', candidates:c, resolvedBy:'precedence:cultural-news'};
  if (has('Spoken Word & Culture') && (has('Comedy') || has('Decades & Oldies'))) return {parent:'Spoken Word & Culture', candidates:c, resolvedBy:'precedence:old-time-radio'};
  if (has('Rock & Alternative') && has('Pop & Contemporary')) return {parent:'Rock & Alternative', candidates:c, resolvedBy:'precedence:pop-rock'};
  if (has('Electronic & Dance') && has('Decades & Oldies')) return {parent:'Electronic & Dance', candidates:c, resolvedBy:'precedence:style-over-decade'};
  if (has('Rock & Alternative') && has('Decades & Oldies')) return {parent:'Rock & Alternative', candidates:c, resolvedBy:'precedence:style-over-decade'};
  if (has('Hip-Hop, Soul, Funk & R&B') && has('Decades & Oldies')) return {parent:'Hip-Hop, Soul, Funk & R&B', candidates:c, resolvedBy:'precedence:style-over-decade'};
  return {parent:null, candidates:c, resolvedBy:null};
}
function noiseKind(g) {
  if (TECHNICAL.test(g)) return 'technical';
  if (GENERIC.test(g)) return 'generic';
  if (GEOGRAPHIC.has(g)) return 'geographic';
  if (NETWORK.has(g)) return 'network-or-brand';
  return null;
}
function styleFacets(raw, parent, candidates, noise) {
  const out = [];
  const value = String(raw ?? '').trim();
  if (value && !noise && foldTaxonomyValue(value) !== foldTaxonomyValue(parent)) out.push(value);
  for (const c of candidates) if (c !== parent && !out.includes(c)) out.push(c);
  return out;
}

function mapStationTaxonomy(station) {
  const rawGenre = station?.genre ?? null;
  const rawTags = Array.isArray(station?.tags) ? [...station.tags] : [];
  const g = foldTaxonomyValue(rawGenre);
  const t = rawTags.map(foldTaxonomyValue).join(' ');
  const exact = EXACT.get(g);
  if (exact) return {genreRaw:rawGenre, tagsRaw:rawTags, genreParent:exact,
    stylesCanonical:styleFacets(rawGenre, exact, [exact], null), mappingVersion:TAXONOMY_VERSION,
    mappingRule:'exact-reviewed-alias', mappingConfidence:1, mappingCandidates:[exact]};
  const rawResolution = resolve(hits(g), g);
  if (rawResolution.parent) return {genreRaw:rawGenre, tagsRaw:rawTags, genreParent:rawResolution.parent,
    stylesCanonical:styleFacets(rawGenre, rawResolution.parent, rawResolution.candidates, null),
    mappingVersion:TAXONOMY_VERSION, mappingRule:rawResolution.resolvedBy || 'raw-genre-rule',
    mappingConfidence:rawResolution.candidates.length === 1 ? 0.95 : 0.9,
    mappingCandidates:rawResolution.candidates};
  if (rawResolution.candidates.length) return {genreRaw:rawGenre, tagsRaw:rawTags,
    genreParent:'Other / Unclassified', stylesCanonical:styleFacets(rawGenre, null, rawResolution.candidates, null),
    mappingVersion:TAXONOMY_VERSION, mappingRule:'ambiguous-raw-genre', mappingConfidence:0,
    mappingCandidates:rawResolution.candidates};
  const noise = noiseKind(g);
  if (!g || noise) {
    const tagResolution = resolve(hits(t), t);
    if (tagResolution.parent) return {genreRaw:rawGenre, tagsRaw:rawTags, genreParent:tagResolution.parent,
      stylesCanonical:styleFacets(rawGenre, tagResolution.parent, tagResolution.candidates, noise || 'empty'),
      mappingVersion:TAXONOMY_VERSION, mappingRule:`tags-fallback-after-${noise || 'empty'}`,
      mappingConfidence:tagResolution.candidates.length === 1 ? 0.8 : 0.75,
      mappingCandidates:tagResolution.candidates};
    return {genreRaw:rawGenre, tagsRaw:rawTags, genreParent:'Other / Unclassified',
      stylesCanonical:styleFacets(rawGenre, null, tagResolution.candidates, noise || 'empty'),
      mappingVersion:TAXONOMY_VERSION,
      mappingRule:tagResolution.candidates.length ? `ambiguous-tags-after-${noise || 'empty'}` : `reviewed-unclassified-${noise || 'empty'}`,
      mappingConfidence:0, mappingCandidates:tagResolution.candidates};
  }
  return {genreRaw:rawGenre, tagsRaw:rawTags, genreParent:'Other / Unclassified',
    stylesCanonical:styleFacets(rawGenre, null, [], null), mappingVersion:TAXONOMY_VERSION,
    mappingRule:'unmapped-review-required', mappingConfidence:0, mappingCandidates:[]};
}

function projectStationTaxonomy(station) {
  return {...station, taxonomy:mapStationTaxonomy(station)};
}
function taxonomySearchTerms(station) {
  const tx = station?.taxonomy ?? mapStationTaxonomy(station);
  return unique([tx.genreRaw, ...tx.tagsRaw, tx.genreParent, ...tx.stylesCanonical]
    .filter(Boolean).map(String));
}
return {TAXONOMY_VERSION,DISPLAY_PARENTS,foldTaxonomyValue,mapStationTaxonomy,projectStationTaxonomy,taxonomySearchTerms};
})();

export const TAXONOMY_VERSION='agent-radio-taxonomy-v1-candidate.5.1';export const DISPLAY_PARENTS=V4.DISPLAY_PARENTS;export const foldTaxonomyValue=V4.foldTaxonomyValue;
const GENERIC=new Set(['','other','misc','undefined','music','radio','commercial','adult','best music for you']);const IGNORE=new Set(['Other / Unclassified','Mixed / Variety','Decades & Oldies']);
const STRONG=new Set(['Electronic & Dance','Rock & Alternative','Metal','Country','Folk & Roots','Reggae & Caribbean','Latin','Jazz','Blues','Classical','Hip-Hop, Soul, Funk & R&B','Ambient & Chill','Religious & Spiritual','Experimental & Avant-Garde','Pop & Contemporary']);
const WEAK=/^(?:hits?|classic hits?|oldies|evergreens|news|talk|talk radio|public radio|national|regional|variety|music|radio|russian|english|spanish|french|german|italian)$/iu;
function unique(a){return[...new Set(a.filter(Boolean))];}
function evidence(tags,strongOnly=false){const out=[];for(const raw of tags||[]){const t=foldTaxonomyValue(raw);if(strongOnly&&WEAK.test(t))continue;const p=V4.mapStationTaxonomy({genre:raw,tags:[]}).genreParent;if(IGNORE.has(p))continue;if(strongOnly&&!STRONG.has(p))continue;if(p==='Pop & Contemporary'&&strongOnly&&!/\bpop\b/u.test(t))continue;if(p==='World & Regional'&&strongOnly&&!/(bollywood|arabic music|african music|indian music|bengali|bangla|bhojpuri|armenian|serbian|croatian|greek music|japanese music|ethnic)/u.test(t))continue;if(!out.includes(p))out.push(p);}return out;}
function finish(base,patch={}){return{...base,...patch,stylesCanonical:unique(patch.stylesCanonical??base.stylesCanonical),mappingVersion:TAXONOMY_VERSION};}
export function mapStationTaxonomy(station){const base=V4.mapStationTaxonomy(station);const raw=foldTaxonomyValue(station?.genre);if(GENERIC.has(raw)){const ps=evidence(station?.tags,false);if(ps.length===1)return finish(base,{genreParent:ps[0],stylesCanonical:[station.genre,...base.stylesCanonical],mappingRule:'candidate5.1:tags-before-generic',mappingConfidence:.85,mappingCandidates:ps});if(ps.length>1)return finish(base,{mappingRule:'candidate5.1:ambiguous-generic-tags',mappingConfidence:0,mappingCandidates:ps});}
 if(base.genreParent==='Decades & Oldies'){const ps=evidence(station?.tags,true);if(ps.length===1)return finish(base,{genreParent:ps[0],stylesCanonical:[station.genre,'Decades & Oldies',...base.stylesCanonical],mappingRule:'candidate5.1:strong-style-over-decade',mappingConfidence:.9,mappingCandidates:[ps[0],'Decades & Oldies']});if(ps.length>1)return finish(base,{mappingRule:'candidate5.1:ambiguous-strong-styles',mappingConfidence:0,mappingCandidates:ps});}
 return finish(base);}
export function projectStationTaxonomy(s){return{...s,taxonomy:mapStationTaxonomy(s)};}export function taxonomySearchTerms(s){const t=s?.taxonomy??mapStationTaxonomy(s);return unique([t.genreRaw,...t.tagsRaw,t.genreParent,...t.stylesCanonical].map(String));}
