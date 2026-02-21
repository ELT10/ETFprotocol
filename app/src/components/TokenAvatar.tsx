'use client';

import { useState } from 'react';

interface TokenAvatarProps {
    symbol: string;
    logoURI?: string;
    className?: string;
    fallbackClassName?: string;
}

export default function TokenAvatar({
    symbol,
    logoURI,
    className = 'size-8',
    fallbackClassName = 'bg-zinc-800',
}: TokenAvatarProps) {
    const [imageError, setImageError] = useState(false);
    const showImage = !!logoURI && !imageError;

    return (
        <div className={`${className} shrink-0 overflow-hidden rounded-full ${fallbackClassName}`}>
            {showImage ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                    src={logoURI}
                    alt={`${symbol} icon`}
                    className="h-full w-full object-cover"
                    onError={() => setImageError(true)}
                />
            ) : (
                <div className="grid h-full w-full place-items-center text-xs font-semibold text-white">
                    {symbol[0] ?? '?'}
                </div>
            )}
        </div>
    );
}
