import * as forge from "node-forge";
import { readFileSync, writeFileSync, chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const CA_VALIDITY_DAYS = 365;
const CA_TTL_HOURS = 24;

interface CachedCert {
  certPem: string;
  keyPem: string;
  createdAt: number;
}

const certCache = new Map<string, CachedCert>();

export interface CaKeypair {
  certPem: string;
  keyPem: string;
}

/**
 * Ensure CA keypair exists on disk. Generates RSA 2048 CA if files don't exist.
 * Stores with 0o600 permissions (read/write owner only).
 */
export function ensureCa(certPath: string, keyPath: string): CaKeypair {
  mkdirSync(dirname(certPath), { recursive: true });
  if (existsSync(certPath) && existsSync(keyPath)) {
    return { certPem: readFileSync(certPath, "utf8"), keyPem: readFileSync(keyPath, "utf8") };
  }

  const attrs = [{ name: "commonName", value: "ai-reverse-engineering CA" }];
  const caKeypair = forge.pki.rsa.generateKeyPair({ bits: 2048 });
  const caSerial = forge.util.bytesToHex(forge.random.getBytesSync(20));

  const cert = forge.pki.createCertificate();
  cert.serialNumber = caSerial;
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setDate(cert.validity.notBefore.getDate() + CA_VALIDITY_DAYS);
  cert.setSubject(attrs);
  cert.setIssuer(attrs); // self-signed
  cert.publicKey = caKeypair.publicKey;
  cert.setExtensions([
    { name: "basicConstraints", cA: true, pathLenConstraint: 0 },
    { name: "keyUsage", keyCertSign: true, digitalSignature: true, keyEncipherment: true },
  ]);
  cert.sign(caKeypair.privateKey, forge.md.sha256.create());

  const certPem = forge.pki.certificateToPem(cert);
  const keyPem = forge.pki.privateKeyToPem(caKeypair.privateKey);

  writeFileSync(certPath, certPem, { mode: 0o600 });
  writeFileSync(keyPath, keyPem, { mode: 0o600 });

  return { certPem, keyPem };
}

function parseCa(caCertPem: string, caKeyPem: string) {
  return {
    caCert: forge.pki.certificateFromPem(caCertPem),
    caKey: forge.pki.privateKeyFromPem(caKeyPem),
  };
}

/**
 * Get or create a leaf certificate for `hostname`, signed by the CA.
 * Caches by hostname; entries older than 24h are lazily invalidated.
 */
export function getLeafCert(
  hostname: string,
  caCertPath: string,
  caKeyPath: string,
): { certPem: string; keyPem: string } {
  const now = Date.now();
  const cached = certCache.get(hostname);
  const ttlMs = CA_TTL_HOURS * 60 * 60 * 1000;
  if (cached && now - cached.createdAt < ttlMs) {
    return { certPem: cached.certPem, keyPem: cached.keyPem };
  }

  const { certPem: caCertPem, keyPem: caKeyPem } = ensureCa(caCertPath, caKeyPath);
  const { caCert, caKey } = parseCa(caCertPem, caKeyPem);

  const leafKeypair = forge.pki.rsa.generateKeyPair({ bits: 2048 });
  const leafSerial = forge.util.bytesToHex(forge.random.getBytesSync(16));

  const leafCert = forge.pki.createCertificate();
  leafCert.serialNumber = leafSerial;
  leafCert.validity.notBefore = new Date();
  leafCert.validity.notAfter = new Date();
  leafCert.validity.notAfter.setDate(leafCert.validity.notBefore.getDate() + 1); // 1 day
  leafCert.setSubject([{ name: "commonName", value: hostname }]);
  leafCert.setIssuer(caCert.subject.attributes);
  leafCert.publicKey = leafKeypair.publicKey;
  leafCert.setExtensions([
    { name: "subjectAltName", altNames: [{ type: 2 /* DNS */, value: hostname }] },
    { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
  ]);
  leafCert.sign(caKey, forge.md.sha256.create());

  const leafCertPem = forge.pki.certificateToPem(leafCert);
  const leafKeyPem = forge.pki.privateKeyToPem(leafKeypair.privateKey);

  certCache.set(hostname, { certPem: leafCertPem, keyPem: leafKeyPem, createdAt: now });

  return { certPem: leafCertPem, keyPem: leafKeyPem };
}
