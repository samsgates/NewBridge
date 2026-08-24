var NewBridgeWebhook = Class.create();
NewBridgeWebhook.prototype = {
  initialize: function () {},

  send: function (current, operation) {
    if (gs.getProperty('x_newbridge_connector.enabled', 'false') !== 'true') return;

    var endpoint = gs.getProperty('x_newbridge_connector.webhook_url', '');
    var secret = gs.getProperty('x_newbridge_connector.webhook_secret', '');
    if (!endpoint || !secret) {
      gs.error('NewBridge connector is enabled but webhook_url or webhook_secret is missing');
      return;
    }

    var delivery = gs.generateGUID();
    var timestamp = new GlideDateTime().getNumericValue().toString();
    var payload = {
      delivery_id: delivery,
      timestamp: timestamp,
      table: current.getTableName(),
      sys_id: current.getUniqueValue(),
      operation: operation,
      sys_updated_on: current.getValue('sys_updated_on')
    };

    var body = JSON.stringify(payload);
    var canonical = [timestamp, delivery, payload.table, payload.sys_id, payload.operation, payload.sys_updated_on || ''].join('\n');
    var mac = new GlideDigest();
    mac.setAlgorithm('HmacSHA256');
    var decodedSecret = GlideStringUtil.base64Decode(secret);
    var signature = mac.getHMACBase64(decodedSecret, canonical);

    var request = new sn_ws.RESTMessageV2();
    request.setEndpoint(endpoint);
    request.setHttpMethod('post');
    request.setRequestHeader('Content-Type', 'application/json');
    request.setRequestHeader('X-NewBridge-Delivery', delivery);
    request.setRequestHeader('X-NewBridge-Timestamp', timestamp);
    request.setRequestHeader('X-NewBridge-Signature', signature);
    request.setRequestBody(body);
    request.setHttpTimeout(10000);
    request.executeAsync();
  },

  type: 'NewBridgeWebhook'
};
