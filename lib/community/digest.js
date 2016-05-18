const Promise = require('bluebird')
const Changes = require('./changes')
const moment = require('moment-timezone')
const rollbar = require('rollbar')
const sails = require('sails')
const truncate = require('html-truncate')

require('colors')
rollbar.init(process.env.ROLLBAR_SERVER_TOKEN)

const userColumns = q => q.column('users.id', 'users.name', 'users.avatar_url')

var Digest = function (community, startTime, endTime, debug) {
  this.community = community
  this.communityName = community.get('name')
  this.startTime = startTime
  this.endTime = endTime
  this.debug = debug

  sails.log.debug(format('%s: Generating digest for %s to %s',
    this.communityName,
    startTime.format('MMM DD YYYY ZZ'),
    endTime.format('MMM DD YYYY ZZ')))
}

// Times in emails (e.g. event times) will be displayed in this time zone.
// This is a stopgap measure; ideally we would store the time zone for each
// recipient and use that.
Digest.defaultTimezone = 'America/Los_Angeles'

Digest.prototype.fetchData = function () {
  var startTime = this.startTime
  var endTime = this.endTime

  return Promise.join(
    // new members
    User.createdInTimeRange(this.community.users(), startTime, endTime)
      .fetch({withRelated: ['skills']}),

    // new posts
    Post.createdInTimeRange(this.community.posts(), startTime, endTime)
      .query(qb => {
        qb.where('post.type', '!=', 'welcome')
        qb.where('post.type', '!=', 'project')
      })
      .fetch({withRelated: [
        {user: userColumns},
        'projects',
        'projects.user'
      ]}),

    // new comments
    Comment.createdInTimeRange(this.community.comments(), startTime, endTime)
      .query(qb => {
        qb.join('post', function () {
          this.on('post.id', 'comment.post_id')
        })
        qb.where('post.type', '!=', 'welcome')
      })
      .fetchAll({withRelated: [
        {user: userColumns}
      ]})
  )
  .spread((users, posts, comments) => {
    // here we use the plain arrays instead of Bookshelf collections
    // so that we can use Lodash methods
    this.users = users.models
    this.posts = posts.models
    return comments.models
  })
  .tap(comments => { // find posts related to new comments
    if (_.isEmpty(comments)) {
      this.commentedPosts = []
      return
    }

    var postIds = _.map(comments, c => c.get('post_id'))

    return Post.query(qb => qb.whereIn('id', postIds))
      .fetchAll({withRelated: [
        {user: userColumns}
      ]})
      .then(commentedPosts => {
        this.commentedPosts = commentedPosts.models

        // group comments by parent post
        commentedPosts.forEach(post => {
          post.comments = _.sortBy(
            _.filter(comments, c => c.get('post_id') === post.id),
            c => c.id
          )
        })
      })
  })
  .tap(() => this.truncateData())
  .tap(() => {
    sails.log.debug(format('%s: %s users, %s new posts, %s commented posts, %s projects %s',
      this.communityName,
      (this.users || []).length,
      (this.posts || []).length,
      (this.commentedPosts || []).length,
      this.tooMuchData ? '(truncated)' : ''
    ))
  })
  .catch(err => {
    sails.log.error(format('%s: %s', this.communityName, err.message).red)
    rollbar.handleError(err)
  })
}

Digest.prototype.truncateData = function () {
  if (this.posts.length > 10) {
    this.tooMuchData = true
    this.posts = _.sampleSize(this.posts, 10)
  }

  if (this.commentedPosts.length > 10) {
    this.tooMuchData = true
    this.commentedPosts = _.sortBy(this.commentedPosts, p => -p.comments.length).slice(0, 10)
  }
}

Digest.prototype.subject = function () {
  var users = _.flatten(this.posts.map(p => p.relations.user)
  .concat(this.commentedPosts.map(p => p.comments.map(c => c.relations.user))))

  var names = _.chain(users.map(u => u.get('name'))).uniq().shuffle().value()

  var summary
  if (names.length > 3) {
    summary = format('New activity from %s, %s, and %s others', names[0], names[1], names.length - 2)
  } else if (names.length === 3) {
    summary = format('New activity from %s, %s, and 1 other', names[0], names[1])
  } else if (names.length === 2) {
    summary = format('New activity from %s and %s', names[0], names[1])
  } else if (names.length === 1) {
    summary = format('New activity from %s', names[0])
  } else {
    summary = 'New members'
  }

  return format('%s: %s %s',
    this.communityName, summary,
    (this.debug ? require('crypto').randomBytes(2).toString('hex') : '')
  )
}

var userAttributes = function (user) {
  return _.chain(user.attributes)
  .pick('avatar_url', 'name')
  .merge({
    url: Frontend.Route.profile(user) + '?ctt=digest_email'
  })
  .value()
}

var renderText = function (text, recipient, token) {
  // add <p> tags to old text
  if (text.substring(0, 3) !== '<p>') {
    text = format('<p>%s</p>', text)
  }

  if (text.match(/data-user-id/)) {
    text = RichText.qualifyLinks(text, recipient, token)
  }

  return text
}

var sameDay = function (moment1, moment2) {
  return moment1.clone().startOf('day').toString() === moment2.clone().startOf('day').toString()
}

var formatTime = function (start, end, timezone) {
  if (!start) return ''

  var calendarOpts = {sameElse: 'dddd, MMM D, YYYY [at] h:mm A'}
  start = moment(start).tz(timezone)
  end = end && moment(end).tz(timezone)

  var startText = start.calendar(null, calendarOpts)
  if (!end) {
    return startText
  } else if (sameDay(start, end)) {
    startText = startText.replace(' at ', ' from ')
    var endText = end.format('h:mm A')
    return format('%s to %s', startText, endText)
  } else {
    return format('%s to %s', startText, end.calendar(null, calendarOpts))
  }
}

Digest.formatTime = formatTime // for testing

Digest.prototype.postAttributes = function (post) {
  return {
    id: post.id,
    user: userAttributes(post.relations.user),
    name: post.get('name'),
    short_name: truncate(post.get('name'), 60),
    description: truncate(post.get('description') || '', 300),
    url: Frontend.Route.post(post) + '?ctt=digest_email',
    location: post.get('location'),
    time: formatTime(post.get('start_time'), post.get('end_time'), Digest.defaultTimezone)
  }
}

var personalizeUrl = function (user, token, obj, key) {
  obj[key] = Frontend.Route.tokenLogin(user, token, obj[key])
}

Digest.prototype.getSharedEmailProps = function () {
  return {
    members: this.users.map(user => {
      return _.merge(userAttributes(user), {
        skills: Skill.simpleList(user.relations.skills)
      })
    }),

    commented_posts: this.commentedPosts.map(post => {
      var attrs = _.merge(this.postAttributes(post), {
        comments: post.comments.map(comment => ({
          text: truncate(comment.get('text'), 140),
          user: userAttributes(comment.relations.user)
        }))
      })

      attrs.commenter_count = attrs.comments.map(c => c.user.name).length
      return attrs
    }),

    posts: this.posts.map(p => this.postAttributes(p)),

    updated_projects: [],

    community_name: this.communityName,
    community_url: Frontend.Route.community(this.community) + '?ctt=digest_email',
    community_avatar_url: this.community.get('avatar_url'),
    digest_title: this.subject(),
    settings_url: Frontend.Route.userSettings(),
    too_much_data: this.tooMuchData
  }
}

Digest.prototype.getEmailProps = function (recipient, token) {
  // generate the data that doesn't change from user to user once & cache it
  if (!this.sharedProps) {
    this.sharedProps = {
      data: this.getSharedEmailProps(recipient)
    }
  }

  // make a copy and add user-specific attributes
  var props = _.merge(_.cloneDeep(this.sharedProps), {
    email: recipient.get('email'),
    data: {
      tracking_pixel_url: Analytics.pixelUrl('Digest', {userId: recipient.id, community: this.communityName})
    }
  })

  props.data.commented_posts
  .concat(props.data.posts)
  .concat(_.flatten(props.data.updated_projects.map(pr => pr.posts))).forEach(post => {
    post.reply_url = Email.postReplyAddress(post.id, recipient.id)
    post.description = renderText(post.description, recipient, token)

    personalizeUrl(recipient, token, post, 'url')
    personalizeUrl(recipient, token, post.user, 'url')
    ;(post.comments || []).forEach(comment => {
      personalizeUrl(recipient, token, comment.user, 'url')
      comment.text = renderText(comment.text, recipient, token)
    })
  })

  props.data.members.forEach(u => personalizeUrl(recipient, token, u, 'url'))
  props.data.updated_projects.forEach(p => personalizeUrl(recipient, token, p, 'url'))
  personalizeUrl(recipient, token, props.data, 'community_url')
  personalizeUrl(recipient, token, props.data, 'settings_url')

  return props
}

const fetchDailyDigestCommunities = ids =>
  Community.query(qb => {
    qb.whereIn('id', ids)
    qb.where('daily_digest', true)
  }).fetchAll()

const fetchRecipients = (community, frequency) =>
  community.users()
  .query({whereRaw: `users.settings->>'digest_frequency' = '${frequency}'`})
  .fetch()

const sendToUser = digest => user =>
  user.generateToken()
  .then(token => Queue.classMethod('Email', 'sendCommunityDigest', digest.getEmailProps(user, token)))

Digest.sendToCommunity = (community, startTime, endTime, frequency) => {
  var digest = new Digest(community, startTime, endTime)
  return digest.fetchData()
  .then(() => fetchRecipients(community, frequency))
  .then(users => {
    sails.log.debug(`${community.get('name')}: Queueing emails for ${users.length} recipients`)
    return Promise.map(users.models, sendToUser(digest))
    .tap(() => sails.log.debug(`${community.get('name')}: Finished queueing`))
    .then(enqueued => enqueued.length)
  })
}

// we intentionally decouple frequency (which controls the list of recipients)
// from startTime and endTime here, in case we need to send digests for an
// arbitrary time range to a list
Digest.sendForTimeRange = function (startTime, endTime, frequency) {
  return Changes.changedCommunities(startTime, endTime)
  .then(fetchDailyDigestCommunities)
  .then(communities => Promise.map(
    communities.models,
    community => Digest.sendToCommunity(community, startTime, endTime, frequency),
    {concurrency: 1}
  ))
}

Digest.sendDaily = function () {
  var today = moment.tz('America/Los_Angeles').startOf('day').add(12, 'hours')
  var yesterday = today.clone().subtract(1, 'day')
  return Digest.sendForTimeRange(yesterday, today, 'daily')
}

Digest.sendWeekly = function () {
  var today = moment.tz('America/Los_Angeles').startOf('day').add(12, 'hours')
  var oneWeekAgo = today.clone().subtract(7, 'day')
  return Digest.sendForTimeRange(oneWeekAgo, today, 'weekly')
}

Digest.test = function (communityId, timeAmount, timeUnit, userId) {
  var now = moment()
  var then = moment().subtract(timeAmount, timeUnit)
  return Community.find(communityId).then(community => {
    var digest = new Digest(community, then, now)
    return digest.fetchData()
    .then(() => User.find(userId))
    .then(sendToUser(digest))
  })
}

module.exports = Digest
