var root = require('root-path')
var setup = require(root('test/setup'))
var Digest = require(root('lib/community/digest'))
var moment = require('moment')

describe('Digest', function () {
  var community, user, p1, p2

  before(() => {
    var now = new Date()

    community = new Community({name: 'foo', slug: 'foo'})
    user = new User({
      name: 'Cat',
      email: 'cat@cat.org',
      active: true,
      created_at: now
    })

    var postAttrs = {
      user_id: user.id,
      name: 'Hi!',
      active: true,
      created_at: now,
      type: 'chat'
    }

    p1 = Post.forge(postAttrs)
    p2 = Post.forge(_.merge(postAttrs, {created_at: moment().subtract(1, 'month')}))

    return setup.clearDb()
    .then(() => Promise.join(
      community.save(),
      user.save()
    ))
    .then(() => Promise.join(
      user.joinCommunity(community),
      p1.save(),
      p2.save()
    ))
    .spread((x, p1, p2) => Promise.join(
      community.posts().attach(p1.id),
      community.posts().attach(p2.id),
      Comment.forge({
        comment_text: 'meow',
        user_id: user.id,
        post_id: p2.id,
        active: true,
        created_at: now
      }).save()
    ))
  })

  describe('.sendTestEmail', function () {
    it("collects correct data and doesn't throw errors", function () {
      this.timeout(5000)
      var startTime = moment().subtract(1, 'week')
      var endTime = moment().add(1, 'minute')
      var digest = new Digest(community, startTime, endTime)

      return digest.fetchData()
      .then(() => {
        expect(digest.users.length).to.equal(1)
        expect(digest.users[0].id).to.equal(user.id)
        expect(digest.posts.length).to.equal(1)
        expect(digest.posts[0].id).to.equal(p1.id)
        expect(digest.commentedPosts.length).to.equal(1)
        expect(digest.commentedPosts[0].id).to.equal(p2.id)
        digest.sendTestEmail(user)
      })
    })
  })

  describe('.formatTime', function () {
    it('handles empty inputs', () => {
      expect(Digest.formatTime(null)).to.equal('')
    })

    it('handles a start time without an end time', () => {
      var start = new Date('2015-01-23 16:00:00Z')
      var expected = 'Friday, Jan 23, 2015 at 11:00 AM'
      expect(Digest.formatTime(start, null, 'America/New_York')).to.equal(expected)
    })

    it('handles a start and end time on the same day', () => {
      var start = new Date('2015-01-23 16:00:00Z')
      var end = new Date('2015-01-24 02:00:00Z')
      var expected = 'Friday, Jan 23, 2015 from 11:00 AM to 9:00 PM'
      expect(Digest.formatTime(start, end, 'America/New_York')).to.equal(expected)
    })

    it('handles a start and end time on different days', () => {
      var start = new Date('2015-01-23 16:00:00Z')
      var end = new Date('2015-01-25 01:00:00Z')
      var expected = 'Friday, Jan 23, 2015 at 11:00 AM to Saturday, Jan 24, 2015 at 8:00 PM'
      expect(Digest.formatTime(start, end, 'America/New_York')).to.equal(expected)
    })
  })
})
