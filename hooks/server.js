require express
require Post

require Hook

start server
  app.post('/services/:community_id/:hook_id/:hook_secret', function (req, res) {
var hook = Hook.find community_id hook_id hook_secret

if not hook res.send 404, return

Check validity of payload
if not valid res.send 400, return

get params from req
Post.create(with params)

return res.ok

});

end
