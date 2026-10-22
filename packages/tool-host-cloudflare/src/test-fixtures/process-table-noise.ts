// Keep a large, unrelated command line alive until its owning host test disconnects.
process.send?.('ready');
process.on('disconnect', () => process.exit(0));
