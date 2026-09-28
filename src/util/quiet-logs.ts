// libsignal prints multi-line dumps (stack traces, whole session objects) on every
// decrypt failure or session rotation. Railway counts each line, so a burst of these
// hits the 500 logs/sec limit. Drop those messages and keep everything else.
const NOISY_PREFIXES = [
    'Session error',
    'Closing session',
    'Closing open session',
    'Opening session',
    'Removing old closed session',
    'Migrating session',
    'Failed to decrypt message',
]

for (const method of ['log', 'info', 'warn', 'error'] as const) {
    const original = console[method].bind(console)
    console[method] = (...args: any[]) => {
        const first = typeof args[0] === 'string' ? args[0] : ''
        if (NOISY_PREFIXES.some(prefix => first.startsWith(prefix))) return
        original(...args)
    }
}

export {}
