// Copyright (c) 2021 The DashQL Authors

const TIME_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
    ['year', 24 * 60 * 60 * 1000 * 365],
    ['month', (24 * 60 * 60 * 1000 * 365) / 12],
    ['day', 24 * 60 * 60 * 1000],
    ['hour', 60 * 60 * 1000],
    ['minute', 60 * 1000],
    ['second', 1000],
];

const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

export function getRelativeTime(to: Date, from: Date = new Date()): string {
    const elapsed = to.getTime() - from.getTime();
    for (const [unitName, unitInMs] of TIME_UNITS) {
        if (Math.abs(elapsed) > unitInMs || unitName == 'second') {
            return rtf.format(Math.round(elapsed / unitInMs), unitName);
        }
    }
    return '';
}
