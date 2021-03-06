var postal = require('postal');
var logger = require('tracer').colorConsole({
  format : "{{timestamp}} <{{title}}> [App] {{message}}",
  dateformat : "HH:MM:ss.l"
});
var Mapper = require('./mapper.js');
var Watcher = require('./watcher.js');
var Librarian = require('./librarian.js');

var watcher = new Watcher(postal);
var crawl = new Mapper(postal);
var librarian = new Librarian(postal);

logger.info('App started');