const removeComments = (postId, knex) => {
  return knex('comment').where('post_id', postId).pluck('id')
  .then(ids => {
    if (ids.length === 0) return
    return knex('comments_tags').where('comment_id', 'in', ids).del()
    .then(() => knex('comment').where('id', 'in', ids).del())
  })
}

export const removePost = postId => {
  return bookshelf.transaction(trx => {
    const remove = table =>
      trx(table).where('post_id', postId).del()

    const unset = (table, col = 'post_id') =>
      trx(table).where(col, postId).update({[col]: null})

    return Promise.all([
      removeComments(postId, trx),
      remove('follower'),
      remove('user_post_relevance'),
      remove('posts_tags'),
      remove('post_community'),
      unset('post', 'parent_post_id')
    ])
    .then(() => trx('post').where('id', postId).del())
  })
}
