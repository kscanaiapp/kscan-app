import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import ts from 'typescript';
import { verifyCapture } from './function-bundle-capture.mjs';

/** Bind the live downloaded bundle to the checked-out, approved source. */
export function verifyCandidateIdentity({ captured, deployed, prior, sourceRoot, functionName, projectRef, verifyJwt, priorCapture }) {
  const capture = JSON.parse(fs.readFileSync(captured.capture_path, 'utf8'));
  const root = path.join(path.dirname(captured.capture_path), 'files');
  const verified = verifyCapture({ capture, captureRoot: root,
    expected: { functionName, productionRef: projectRef } });
  if (!verified.ok || capture.bundle_layout !== 'functions-root' ||
      capture.entrypoint !== `${functionName}/index.ts` || capture.verify_jwt !== verifyJwt ||
      capture.live_version !== deployed?.version || capture.ezbr_sha256 !== deployed?.ezbr_sha256 ||
      !/^[a-f0-9]{64}$/.test(capture.ezbr_sha256 || '') || deployed?.status !== 'ACTIVE' || deployed?.verify_jwt !== verifyJwt) {
    throw new Error('Deployed bundle identity does not match the candidate verification capture');
  }
  // Compare every deployed dependency and asset, not just the entrypoint.
  const capturedPaths = new Set(capture.files.map((file) => file.path));
  for (const file of capture.files) {
    const approved = path.join(sourceRoot, file.path);
    if (!fs.existsSync(approved) || !fs.lstatSync(approved).isFile() ||
        crypto.createHash('sha256').update(fs.readFileSync(approved)).digest('hex') !== file.sha256) {
      throw new Error('Deployed source closure differs from approved candidate');
    }
    if (/\.(?:[cm]?[jt]s|[jt]sx)$/.test(file.path)) {
      const source = ts.createSourceFile(file.path, fs.readFileSync(approved, 'utf8'), ts.ScriptTarget.Latest, true);
      const visit = (node) => {
        const specifier = ts.isImportDeclaration(node) || ts.isExportDeclaration(node) ? node.moduleSpecifier :
          ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword ? node.arguments[0] : null;
        if (specifier && ts.isStringLiteral(specifier) && specifier.text.startsWith('.')) {
          const dependency = path.posix.normalize(path.posix.join(path.posix.dirname(file.path), specifier.text));
          if (!capturedPaths.has(dependency)) throw new Error('Deployed source closure is missing an approved local dependency');
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  }
  const version = Number(deployed.version);
  const previous = prior ? Number(prior.version) : 0;
  if (!Number.isSafeInteger(version) || version < 1 || !Number.isSafeInteger(previous) || version < previous) {
    throw new Error('Deployed version relationship cannot be verified');
  }
  if (prior && version === previous && (!priorCapture ||
      priorCapture.tree_digest !== capture.tree_digest || priorCapture.ezbr_sha256 !== capture.ezbr_sha256)) {
    throw new Error('Unchanged deployment is not an exact same-source candidate');
  }
  return { verified: true, tree_digest: capture.tree_digest, file_count: capture.file_count,
    entrypoint: capture.entrypoint, version, same_source_noop: Boolean(prior && version === previous) };
}
