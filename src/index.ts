#! /usr/bin/env node

import prompts from "prompts";
import * as process from "process";
import fs from "fs/promises";
import path from "path";
import {
  equalBytes,
  hexToBytes,
  maybeInitDefaultPortals,
  setActivePortalMasterKey,
  uploadObject,
} from "@lumeweb/libweb";
import chalk from "chalk";
import * as util from "util";
import { fileExists } from "./utils.js";
import * as bip39 from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { HDKey } from "ed25519-keygen/hdkey";

import {
  BOOTSTRAP_NODES,
  CID,
  createKeyPair,
  createNode,
  S5NodeConfig,
  SignedRegistryEntry,
} from "@lumeweb/libs5";

import { MemoryLevel } from "memory-level";
import KeyPairEd25519 from "@lumeweb/libs5/lib/ed25519.js";
import defer from "p-defer";

const BIP44_PATH = "m/44'/1627'/0'/0'/0'";

let key = process.env.PORTAL_PRIVATE_KEY;

if (!key) {
  // @ts-ignore
  key = await prompts.prompts.password({
    name: "private_key",
    message: "Enter your portal private key",
    validate: (prev) => prev && prev.length === 64,
  });
}

let seed = process.env.MODULE_SEED;
if (["0", "false"].includes(seed as string)) {
  seed = false as any;
}
if (!seed && seed === undefined) {
  const seedFile = path.join(process.cwd(), ".module-seed");
  if (await fileExists(seedFile)) {
    seed = await fs.readFile(seedFile, "utf8");
  }

  if (!seed) {
    seed = bip39.generateMnemonic(wordlist);
    await fs.writeFile(seedFile, seed);
  }
}

const hdKey = seed
  ? HDKey.fromMasterSeed(await bip39.mnemonicToSeed(seed as string)).derive(
      BIP44_PATH,
    )
  : false;

let file = process.env.MODULE_FILE;

if (!file || !(await fileExists(file))) {
  const cwd = process.cwd();

  const locations = [
    "dist/module.js",
    "dist/index.js",
    "lib/module.js",
    "lib/index.js",
  ];

  const promises = locations.map((item) => {
    item = path.join(cwd, item);
    return [item, fileExists(item)];
  });

  const pResults: boolean[] = await Promise.all(
    promises.map((item) => item[1] as Promise<boolean>),
  );
  const results = pResults.reduce((prev, cur, index) => {
    if (cur) {
      prev.push(locations[index]);
    }

    return prev;
  }, [] as any);

  if (!results.length) {
    console.error("Kernel module could not be found");
    process.exit(1);
  }

  file = results[0];
}

setActivePortalMasterKey(hexToBytes(key as string));
maybeInitDefaultPortals();

const fd = await fs.open(file as string);

let cid;

try {
  cid = await uploadObject(
    fd.createReadStream(),
    BigInt((await fd.stat()).size),
  );
} catch (e) {
  console.error("Failed to publish: ", e.message);
  process.exit();
}

console.log(
  util.format(
    "%s: %s",
    chalk.green("Kernel module successfully published"),
    cid,
  ),
);

if (!hdKey) {
  process.exit(0);
}

const db = new MemoryLevel<string, Uint8Array>({
  storeEncoding: "view",
  valueEncoding: "buffer",
});
await db.open();

let config = {
  keyPair: createKeyPair(),
  db,
  p2p: {
    peers: {
      initial: [...BOOTSTRAP_NODES],
    },
  },
  logger: {
    info: (s: string) => {},
    verbose: (s: string) => {},
    warn: (s: string) => {},
    error: (s: string) => {},
    catched: (e: any, context?: string | null) => {},
  },
} as S5NodeConfig;

const node = createNode(config);
await node.start();

const peerDefer = defer();

node.services.p2p.once("peerConnected", peerDefer.resolve);

await peerDefer.promise;
{
  const key = hdKey as HDKey;

  let revision = 0;
  let sre: SignedRegistryEntry;

  const ret = await node.services.registry.get(
    new KeyPairEd25519(key.privateKey).publicKey,
  );

  if (ret) {
    revision = ret.revision + 1;
  }

  let newEntry;
  try {
    newEntry = CID.decode(cid).toRegistryEntry();
  } catch (e) {
    console.error("Failed to publish: ", e.message);
    process.exit();
  }

  if (!equalBytes(ret?.data ?? new Uint8Array(), newEntry)) {
    sre = node.services.registry.signRegistryEntry({
      kp: new KeyPairEd25519((hdKey as HDKey).privateKey),
      data: newEntry,
      revision,
    });

    await node.services.registry.set(sre);
  } else {
    sre = ret as SignedRegistryEntry;
  }

  let resolverCid;

  try {
    resolverCid = CID.fromRegistryPublicKey(sre.pk);
  } catch (e) {
    console.error("Failed to publish: ", e.message);
    process.exit();
  }

  console.log(
    util.format("%s: %s", chalk.green("Resolver entry"), resolverCid),
  );
  await node.stop();
}
