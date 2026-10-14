const workerUrl = new URL(self.location.href).searchParams.get('workerUrl');
if (workerUrl == null) throw new Error('Missing HyperDB worker URL');
self.importScripts(workerUrl);
