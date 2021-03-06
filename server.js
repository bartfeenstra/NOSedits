require('dotenv').config();

const Parser = require('rss-parser'),
      parser = new Parser(),
      moment = require('moment'),
      Twit = require('twit'),
      config = {
        twitter: {
          consumer_key: process.env.CONSUMER_KEY,
          consumer_secret: process.env.CONSUMER_SECRET,
          access_token: process.env.ACCESS_TOKEN,
          access_token_secret: process.env.ACCESS_TOKEN_SECRET
        }
      };

const T = new Twit(config.twitter);
const StatsD = require('hot-shots');
let dd_options = {
  prefix: "nosedits-"
};
const telemetry = new StatsD(dd_options);

const SCRAPER_INTERVAL = 30; //seconds
const TELEMETRY_INTERVAL = 60; //seconds
const PURGE_INTERVAL = 24; //hours
const PURGE_TRESHOLD = 48; //hours

// All NOS feeds to cycle through
const ROOT = "http://feeds.nos.nl/";
const FEEDS = [
  "nosnieuwsbinnenland"
  ,"nosnieuwsalgemeen"
  ,"nosnieuwsbuitenland"
  ,"nosnieuwspolitiek"
  ,"nosnieuwseconomie"
  ,"nosnieuwscultuurenmedia"
  ,"nosnieuwstech"
  ,"nosnieuwskoningshuis"
];

// Maintain a collection of all articles
let articles = [];



// Run the article scraper every SCRAPER_INTERVAL seconds
retrieveArticles();
setInterval(() => {
  retrieveArticles();
}, SCRAPER_INTERVAL * 1000)

// Run The Purge (2013) every PURGE_INTERVAL hours
setInterval(() => {
  purgeArticles();
}, PURGE_INTERVAL * 60 * 60 * 1000);

// Ping the telemetry server every TELEMETRY_INTERVAL seconds so it knows we're still alive
setInterval(() => {
  telemetry.check('service.up', telemetry.CHECKS.OK);
  
  for (FEEDINDEX in FEEDS) {
    let category = FEEDS[FEEDINDEX].replace(/(NOS(\.nl)?)|(nieuws)/gi, '').capitalize();
    let inCategoryCount = articles.filter(article => {
      return article.category == category;
    });
    
    telemetry.histogram(category, inCategoryCount.length);
  }
}, TELEMETRY_INTERVAL * 1000);



// Main loop - check for new articles in all feeds
async function retrieveArticles() {
  let totalLength = 0;

  for (FEEDINDEX in FEEDS) {
    let feed = await parser.parseURL(ROOT + FEEDS[FEEDINDEX]);
    let category = feed.title.replace(/(NOS(\.nl)?)|(nieuws)/gi, '').capitalize().trim();
    totalLength = totalLength + feed.items.length;
    feed.items.forEach(item => {
      if (category) {
        checkArticleForNewTitle(item, category);
      }
    });
  }
  
  doAfterCheck(totalLength);
}

function checkArticleForNewTitle(newArticle, injectCategory) {
  // Inject category so we can display it later
  newArticle.category = injectCategory

  // Article exists, check if title has changed since the last time we saw it
  let existingArticle = articles.find((article, index, array) => {
    return (article.guid == newArticle.guid && article.category == newArticle.category);
  });

  if (!!existingArticle) {
    if ((existingArticle.title != newArticle.title) && (existingArticle.category == newArticle.category)) {
      // Title has changed, send out a Tweet
      notifyTitleChanged(newArticle, existingArticle);

      // Set old article to new info, otherwise the article would trigger notifyTitleChanged again in the next cycle
      console.log(`Replacing article at index ${articles.indexOf(existingArticle)} in collection.`)
      articles[articles.indexOf(existingArticle)] = newArticle;
    }

    // Title hasn't changed and we already have the article in our collection
    telemetry.increment('article_stale');
  } else {
    // New (unseen) article, add it to our collection
    articles.push(newArticle);
    telemetry.increment('article_new');
  }
}

// Send tweet that the title of an article has changed
function notifyTitleChanged(newArticle, existingArticle) {
  telemetry.increment('article_changed');
  let cat = newArticle.category ? '[' + newArticle.category + ']' : '';
  let statusText = `${cat} De kop «${existingArticle.title.trim()}» is zojuist gewijzigd naar «${newArticle.title.trim()}» ${newArticle.guid}`;
  let params = { 
    status: statusText
  }

  T.post('statuses/update', params, function (err, data, response) {
    if (err) {
      if (err.code)
      console.log('Error!', err.message);
      telemetry.event('Status update failed', `Error ${err.code}: ${err.message}`);
      telemetry.check("tweet_result", telemetry.CHECKS.WARNING);
      telemetry.increment('error_rate');
    } else {
      telemetry.check("tweet_result", telemetry.CHECKS.OK);
      console.log(`Sent out a tweet: ${statusText} -- Oldcat: ${existingArticle.source}, newcat: ${newArticle.source}`);
    }
  })
}



function purgeArticles() {
  // Retain articles only when they're no older than 48 hours
  let rightNow = moment(), countPurged = 0, total = articles.length;
  let twoDaysAgo = rightNow.subtract(2, "days");
  
  articles.filter(article => {
    let theDateThisWasPublished = moment(article.pubDate);
    let isTooOld = theDateThisWasPublished.isBefore(twoDaysAgo, "hour");
    if (isTooOld) countPurged++;
    return !isTooOld;
  });

  telemetry.histogram("count_purged", countPurged);
  console.log(`Purged ${countPurged} articles (${Math.floor(countPurged / total * 100)}%)`)
}

function doAfterCheck(totalLength) {
  telemetry.histogram('article_count', articles.length);
  telemetry.histogram('feeditems_count', totalLength);
}

String.prototype.capitalize = function() {
  return this.replace(/(?:^|\s)\S/g, function(a) { return a.toUpperCase(); });
};