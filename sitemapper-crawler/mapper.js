var Crawler = require('simplecrawler');
var cheerio = require('cheerio');
var _ = require('underscore');
var fs = require('fs');
var mkdirp = require('mkdirp');
var SitemapperCache = require('./cache-sitemapper.js');
var logger = require('tracer').colorConsole({
  format : "{{timestamp}} <{{title}}> [Mapper] {{message}}",
  dateformat : "HH:MM:ss.l",
  level:'info'
});

"use strict";

var Mapper = function (postal) {
  var mapper = this;
  mapper.postal = postal;

  mapper.queue = [];
  mapper.crawlers = [];
  // mapper.completedSites = [];
  mapper.CRAWL_LIMIT = 5;
  mapper.interval = 5;

  mapper.postal.subscribe({
    channel: 'Sites',
    topic:   'added',
    callback: mapper.addSite
  }).withContext(mapper);

  mapper.start();
};

Mapper.prototype.start = function () {
  var mapper = this;

  setInterval(function () {
    mapper.checkCrawlers();
    mapper.addCrawlers();
  }, 1000 * mapper.interval);
};

// Adds a site in the queue.
Mapper.prototype.addSite = function (data, envelope) {
  var mapper = this;

  // Should add extra check conditions here.
  if (data.status !== 2 && _.findWhere(mapper.queue, { _id: data._id }) === undefined) {
    mapper.queue.push(data);
    logger.info('%s pushed into crawling queue.', data.host);
    // Queue gets sorted by the date it was added. Oldest is first.
    // It probably will be like sorted already but can't promise that
    var sorted = _.sortBy(mapper.queue, function (site) {
      return site.created_at;
    });
  } else {
    logger.log('Did not add %s', data.host);
  }
};

// Checks to make sure a crawler can be fired up
Mapper.prototype.addCrawlers = function () {
  var mapper = this;

  if (mapper.queue.length === 0) {
    logger.log('No new sites to crawl');
    return;
  }

  logger.log("Sites to crawl %s.", mapper.queue.length);

  if (mapper.crawlers >= mapper.CRAWL_LIMIT) {
    logger.warn('At crawl limit (%s)', mapper.CRAWL_LIMIT);
    return;
  }

  var nextSite = mapper.queue.shift();

  logger.info('started crawling %s', nextSite.host);
  mapper.crawlers.push(mapper.newCrawler(nextSite));
};

/**
 * Checks in and sends stats back to meteor
 * TODO removing crawlers once they are complete
 * from here doesn't make sense. This could be put somewhere
 * else so that we don't have to wait every interval to do
 * the work.
 * @return {[type]} [description]
 */
Mapper.prototype.checkCrawlers = function () {
  var mapper = this;

  _.each(mapper.crawlers, function (crawler, index, list) {
    logger.log("Crawler %s has %s items in the queue.", crawler.host, crawler.queue.countWithStatus('queued'));

    crawler.site.pagesScanned = crawler.queue.complete();
    crawler.site.pagesLeft    = crawler.queue.countWithStatus('queued');

    if (crawler.site.status === 2) {
      mapper.postal.publish({
          channel: 'Sites',
          topic: 'completed',
          data: crawler.site
      });

      list.splice(index, 1);
    }

    mapper.postal.publish({
        channel: 'Sites',
        topic: 'updated',
        data: crawler.site
    });
  });
};

// Heavy lifting happens here!
Mapper.prototype.newCrawler = function (_site) {
  var mapper = this;
  var site = _site;

  if (site._id === undefined) {
    throw new Error("Scan ID required");
  }

  if (site.host === undefined) {
    throw new Error("target site undefined");
  }

  // Create the crawler
  var crawler = new Crawler(site.host);

  crawler.site                = site; // Stash this for later
  crawler.stripQuerystring    = true;
  crawler.maxConcurrency      = 5;
  // crawler.interval            = 6000;
  crawler.timeout             = 30000;

  // SAVE TO DISK LIKE A BOSS
  // TODO - Make this async so it doesn't block existing crawls
  crawler.site.storagePath = 'cached_sites/' + site._id;
  mkdirp.sync(site.storagePath);
  crawler.cache = new SitemapperCache(site.storagePath);

  // Exclude things that we don't want
  // In the future we will use the config for this
  // var noJS = crawler.addFetchCondition(function(parsedURL) {
  //     return !parsedURL.path.match(/\.js$/i);
  // });

  // var noCSS = crawler.addFetchCondition(function(parsedURL) {
  //     return !parsedURL.path.match(/\.css$/i);
  // });

  // var noPNG = crawler.addFetchCondition(function(parsedURL) {
  //     return !parsedURL.path.match(/\.png$/i);
  // });

  // var noJPG = crawler.addFetchCondition(function(parsedURL) {
  //     return !parsedURL.path.match(/\.jpg$/i);
  // });

  // var noKML = crawler.addFetchCondition(function(parsedURL) {
  //     return !parsedURL.path.match(/\.kml$/i);
  // });

  // var noMovie = crawler.addFetchCondition(function(parsedURL) {
  //     return !parsedURL.path.match(/\.mp4$/i);
  // });

  // Could put the path in at this point, but wait until everything is done

  crawler.cache.on("setcache", function (queueItem,data,cacheObject) {
    mapper.postal.publish({
      channel: 'Pages',
      topic: 'crawled',
      data: {
        url: queueItem.url,
        sitescan_id: crawler.site._id,
        cacheObject: cacheObject
      }
    });
  });

  crawler.on("fetchcomplete", function (queueItem, responseBuffer, response) {
    var title = "";

    if (queueItem.stateData.contentType == "text/html") {
      var $content = cheerio.load(responseBuffer.toString());
      title = $content('title').html();
      logger.log('Title is %s', title);
    }

    mapper.postal.publish({
      channel: 'Pages',
      topic: 'crawled',
      data: {
        queueItem: queueItem,
        url: queueItem.url,
        title: title,
        sitescan_id: crawler.site._id,
        type: queueItem.stateData.contentType,
        code: queueItem.stateData.code,
        size: queueItem.stateData.actualDataSize,
        status: 'unlinked'
      }
    });
  });

  crawler.site.status = 1; // Indicate this guy is started

  mapper.postal.publish({
    channel: 'Sites',
    topic: 'started',
    data: crawler.site
  });

  crawler.start();

  crawler.on("complete", function() {
    logger.info("Finished crawling %s", crawler.host);
    crawler.site.fileIndex = crawler.cache.datastore.index;
    crawler.site.status = 2; // She's done and we'll notify home next round of updates
  });

  return crawler;
};

module.exports = Mapper;