/// Random two-word name generator for new scripts.
///
/// Instead of naming every new script "script", we compose a memorable "<adjective>_<animal>" base
/// (e.g. "brave_otter") in the spirit of whimsical generated names. The two curated
/// word lists give ADJECTIVES.length * ANIMALS.length combinations, so collisions on a single page
/// are rare; when one does occur the caller's uniqueScriptBase still disambiguates with a "-2" suffix.

const ADJECTIVES: readonly string[] = [
    'amber', 'ancient', 'autumn', 'azure', 'bold', 'brave', 'breezy', 'bright',
    'brisk', 'calm', 'clever', 'cosmic', 'crimson', 'crisp', 'curious', 'daring',
    'dawn', 'deep', 'eager', 'electric', 'emerald', 'fancy', 'fearless', 'fierce',
    'fluffy', 'frosty', 'gentle', 'gilded', 'golden', 'happy', 'hidden', 'humble',
    'icy', 'indigo', 'jolly', 'keen', 'lively', 'lucid', 'lucky', 'mellow',
    'merry', 'mighty', 'misty', 'nimble', 'noble', 'patient', 'placid', 'polished',
    'proud', 'quiet', 'rapid', 'royal', 'rugged', 'rustic', 'scarlet', 'serene',
    'silent', 'silver', 'sleek', 'snowy', 'solar', 'spry', 'stellar', 'sturdy',
    'sunny', 'swift', 'tidy', 'tranquil', 'velvet', 'vivid', 'wandering', 'wise',
    'witty', 'zesty',
];

const ANIMALS: readonly string[] = [
    'badger', 'bat', 'bear', 'beaver', 'bison', 'cheetah', 'cobra', 'condor',
    'cougar', 'coyote', 'crane', 'cricket', 'dingo', 'dolphin', 'eagle', 'falcon',
    'ferret', 'finch', 'fox', 'gazelle', 'gecko', 'gibbon', 'heron', 'ibex',
    'iguana', 'impala', 'jackal', 'jaguar', 'kestrel', 'koala', 'lemur', 'leopard',
    'lynx', 'magpie', 'mantis', 'marmot', 'marten', 'meerkat', 'mole', 'moose',
    'narwhal', 'newt', 'ocelot', 'orca', 'osprey', 'otter', 'owl', 'panda',
    'panther', 'pelican', 'penguin', 'puffin', 'puma', 'quail', 'rabbit', 'raccoon',
    'raven', 'salmon', 'seal', 'shark', 'sparrow', 'stoat', 'stork', 'tapir',
    'teal', 'tiger', 'toucan', 'turtle', 'viper', 'vole', 'walrus', 'weasel',
    'wolf', 'wombat',
];

/// How many random combinations to try before giving up on finding a collision-free one. With a few
/// thousand combinations this practically never exhausts; the caller still de-duplicates afterwards.
const MAX_ATTEMPTS = 32;

function pick(list: readonly string[], rng: () => number): string {
    return list[Math.floor(rng() * list.length)];
}

/// Generate a random "<adjective>-<animal>" script base. If `taken` is given, retries a bounded number
/// of times to avoid names already present; on exhaustion it returns a name regardless (the caller's
/// uniqueScriptBase appends a numeric suffix to guarantee uniqueness). `rng` is injectable for tests.
export function randomScriptName(taken?: ReadonlySet<string>, rng: () => number = Math.random): string {
    let candidate = `${pick(ADJECTIVES, rng)}_${pick(ANIMALS, rng)}`;
    if (!taken) return candidate;
    for (let attempt = 0; taken.has(candidate) && attempt < MAX_ATTEMPTS; ++attempt) {
        candidate = `${pick(ADJECTIVES, rng)}_${pick(ANIMALS, rng)}`;
    }
    return candidate;
}
