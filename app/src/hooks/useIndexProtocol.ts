import { useAnchorWallet, useConnection } from '@solana/wallet-adapter-react';
import { Program, AnchorProvider, Idl } from '@coral-xyz/anchor';
import { PublicKey } from '@solana/web3.js';
import { useMemo } from 'react';
import { IndexProtocol } from '../utils/idl/index_protocol';
import idl from '../utils/idl/index_protocol.json';
import { getIndexProtocolProgramId } from '@/utils/network';

export const useIndexProtocol = () => {
    const { connection } = useConnection();
    const wallet = useAnchorWallet();
    const programId = useMemo(() => new PublicKey(getIndexProtocolProgramId()), []);
    const resolvedIdl = useMemo(
        () => ({ ...(idl as Idl), address: programId.toBase58() }) as Idl,
        [programId]
    );

    const provider = useMemo(() => {
        if (!wallet) return null;
        return new AnchorProvider(connection, wallet, {
            commitment: 'confirmed',
            preflightCommitment: 'confirmed',
        });
    }, [connection, wallet]);

    const program = useMemo(() => {
        if (!provider) return null;
        return new Program(resolvedIdl, provider) as unknown as Program<IndexProtocol>;
    }, [provider, resolvedIdl]);

    return { program, provider, wallet, programId };
};
