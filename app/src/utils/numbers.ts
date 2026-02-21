interface StringableNumberLike {
    toString: () => string;
}

export function numberLikeToNumber(value: unknown, fallback = 0): number {
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : fallback;
    }

    if (typeof value === 'bigint') {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : fallback;
    }

    if (typeof value === 'string') {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : fallback;
    }

    if (typeof value === 'object' && value !== null) {
        const parsed = Number((value as StringableNumberLike).toString());
        return Number.isFinite(parsed) ? parsed : fallback;
    }

    return fallback;
}
