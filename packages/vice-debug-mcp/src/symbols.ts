import fs from 'node:fs/promises';
import path from 'node:path';

import { normalizeHex, type SymbolRecord, type SymbolSourceRecord } from './contracts.js';
import { validationError } from './errors.js';

interface Oscar64DebugJson {
  functions?: Array<{
    name?: string;
    start: number;
    end?: number;
    source?: string;
    line?: number;
  }>;
  variables?: Array<{
    name?: string;
    start: number;
    end?: number;
    typeid?: number;
  }>;
}

interface LoadedSymbolSource {
  metadata: SymbolSourceRecord;
  symbols: SymbolRecord[];
}

export class SymbolService {
  #sources: LoadedSymbolSource[] = [];

  async loadOscar64Symbols(filePath: string): Promise<SymbolSourceRecord> {
    const absolutePath = path.resolve(filePath);
    const raw = await fs.readFile(absolutePath, 'utf8');

    let parsed: LoadedSymbolSource | null = null;
    try {
      parsed = this.#fromOscar64Json(absolutePath, raw);
    } catch {
      parsed = this.#fromOscar64Asm(absolutePath, raw);
    }

    if (!parsed || parsed.symbols.length === 0) {
      validationError('Could not parse any Oscar64 symbols from file', { filePath: absolutePath });
    }

    this.#sources = this.#sources.filter((source) => source.metadata.filePath !== absolutePath);
    this.#sources.push(parsed);
    return parsed.metadata;
  }

  listSources(): SymbolSourceRecord[] {
    return this.#sources.map((source) => source.metadata);
  }

  lookup(name: string): SymbolRecord | null {
    const normalized = name.trim();
    for (let index = this.#sources.length - 1; index >= 0; index -= 1) {
      const hit = this.#sources[index]!.symbols.find((symbol) => symbol.name === normalized);
      if (hit) {
        return hit;
      }
    }
    return null;
  }

  #fromOscar64Json(filePath: string, raw: string): LoadedSymbolSource {
    const parsed = JSON.parse(raw) as Oscar64DebugJson;
    const symbols: SymbolRecord[] = [];

    for (const fn of parsed.functions ?? []) {
      if (!fn.name) {
        continue;
      }
      symbols.push({
        name: fn.name,
        address: fn.start,
        addressHex: normalizeHex(fn.start),
        endAddress: fn.end,
        endAddressHex: fn.end == null ? undefined : normalizeHex(fn.end),
        source: fn.source,
        line: fn.line,
        kind: 'function',
      });
    }

    for (const variable of parsed.variables ?? []) {
      if (!variable.name) {
        continue;
      }
      symbols.push({
        name: variable.name,
        address: variable.start,
        addressHex: normalizeHex(variable.start),
        endAddress: variable.end,
        endAddressHex: variable.end == null ? undefined : normalizeHex(variable.end),
        kind: 'global',
      });
    }

    return {
      metadata: {
        id: `symbol-source:${Buffer.from(filePath).toString('base64url')}`,
        format: 'oscar64-json',
        filePath,
        symbolCount: symbols.length,
        loadedAt: new Date().toISOString(),
      },
      symbols,
    };
  }

  #fromOscar64Asm(filePath: string, raw: string): LoadedSymbolSource {
    const symbols: SymbolRecord[] = [];
    const labelPattern = /^\s*([A-Za-z_.$@][\w.$@]*)\s*[:=]\s*\$?([0-9A-Fa-f]{2,4})\b/mg;

    for (const match of raw.matchAll(labelPattern)) {
      const name = match[1];
      const address = Number.parseInt(match[2]!, 16);
      symbols.push({
        name,
        address,
        addressHex: normalizeHex(address),
        kind: 'label',
      });
    }

    return {
      metadata: {
        id: `symbol-source:${Buffer.from(filePath).toString('base64url')}`,
        format: 'oscar64-asm',
        filePath,
        symbolCount: symbols.length,
        loadedAt: new Date().toISOString(),
      },
      symbols,
    };
  }
}
