# Register bundled Scenes explicitly

TavernNext registers every bundled official Scene in one explicit application Registry and builds each Package from its self-contained `manifest.json` directory. Registry membership is the trust boundary; Package frontend modules own Scene View rendering and run inside Shadow DOM when embedded in shared Chat. Installed Scene upgrades replace assets and manifests while leaving existing Save data untouched, so Scene authors—not the platform—own backward compatibility with prior Scene State shapes.
