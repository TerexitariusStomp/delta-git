-- Seed blueprint template catalog (P3 marketplace)
INSERT OR REPLACE INTO meta(k, v) VALUES('templates', '[
  {"id":"blank","name":"Blank site","desc":"Vanilla WordPress","blueprint":{"landingPage":"/wp-admin/","steps":[]}},
  {"id":"blog","name":"Blog","desc":"Twenty Twenty-Five + starter posts","blueprint":{"landingPage":"/wp-admin/","steps":[{"step":"setSiteOptions","options":{"blogname":"My Blog"}}]}},
  {"id":"portfolio","name":"Portfolio","desc":"Blocks theme + contact page","blueprint":{"landingPage":"/wp-admin/","steps":[{"step":"installPlugin","pluginData":{"resource":"wordpress.org/plugins","slug":"contact-form-7"}}]}},
  {"id":"store","name":"Store (Lane 3)","desc":"WooCommerce — provisions a container","lane":3,"blueprint":{"landingPage":"/wp-admin/","steps":[{"step":"installPlugin","pluginData":{"resource":"wordpress.org/plugins","slug":"woocommerce"}}]}}
]');
