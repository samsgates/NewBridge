(function executeRule(current, previous /* null when async */) {
  var operation = current.operation();
  if (operation !== 'insert' && operation !== 'update' && operation !== 'delete') return;
  new NewBridgeWebhook().send(current, operation);
})(current, previous);
