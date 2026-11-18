const express = require('express');
const router = express.Router();
const { getSupabase, isSupabaseAvailable } = require('../config/supabase');
const memoryStore = require('../config/memoryStore');

// Get all chat messages
router.get('/all', async (req, res) => {
  if (!isSupabaseAvailable()) {
    const limit = parseInt(req.query.limit) || 100;
    return res.json({ status: true, data: memoryStore.getChatMessages(limit) });
  }
  const supabase = getSupabase();
  try {
    const limit = parseInt(req.query.limit) || 100;
    
    const { data: messages, error } = await supabase
      .from('chat_messages')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      console.error('Get chat error:', error);
      return res.json({ status: false, message: 'Failed to get chat messages' });
    }

    res.json({
      status: true,
      data: messages.reverse()
    });
  } catch (error) {
    console.error('Get chat error:', error);
    res.json({ status: false, message: 'Failed to get chat messages' });
  }
});

// Send chat message
router.post('/send', async (req, res) => {
  try {
    if (!isSupabaseAvailable()) {
      return res.json({ status: false, message: 'Database not configured' });
    }
    const supabase = getSupabase();
    const { userId, userName, avatar, message, img } = req.body;

    if (!message || !userName) {
      return res.json({ status: false, message: 'Message and username are required' });
    }

    const { data: chat, error } = await supabase
      .from('chat_messages')
      .insert([{
        user_id: userId || 'anonymous',
        user_name: userName,
        avatar: avatar || '',
        message,
        img: img || ''
      }])
      .select()
      .single();

    if (error) {
      console.error('Send chat error:', error);
      return res.json({ status: false, message: 'Failed to send message' });
    }

    res.json({
      status: true,
      data: chat
    });
  } catch (error) {
    console.error('Send chat error:', error);
    res.json({ status: false, message: 'Failed to send message' });
  }
});

// Like a chat message
router.post('/like', async (req, res) => {
  try {
    const { chatID, userId } = req.body;
    if (!chatID || !userId) {
      return res.json({ status: false, message: 'chatID and userId are required' });
    }

    if (!isSupabaseAvailable()) {
      const msg = memoryStore.toggleChatReaction(chatID, userId, 'like');
      if (!msg) return res.json({ status: false, message: 'Message not found' });
      return res.json({ status: true, data: msg });
    }

    const supabase = getSupabase();

    const { data: chat } = await supabase
      .from('chat_messages')
      .select('*')
      .eq('id', chatID)
      .single();
    
    if (!chat) {
      return res.json({ status: false, message: 'Message not found' });
    }

    // Check if user already liked
    if (chat.likes_ids?.includes(userId)) {
      return res.json({ status: false, message: 'Already liked' });
    }

    // Remove dislike if exists
    let newDislikesIds = chat.dislikes_ids || [];
    let newDislikes = chat.dislikes;
    const dislikeIndex = newDislikesIds.indexOf(userId);
    if (dislikeIndex > -1) {
      newDislikesIds.splice(dislikeIndex, 1);
      newDislikes--;
    }

    // Add like
    let newLikesIds = chat.likes_ids || [];
    newLikesIds.push(userId);
    const newLikes = (chat.likes || 0) + 1;

    const { data: updatedChat, error } = await supabase
      .from('chat_messages')
      .update({
        likes: newLikes,
        likes_ids: newLikesIds,
        dislikes: newDislikes,
        dislikes_ids: newDislikesIds
      })
      .eq('id', chatID)
      .select()
      .single();

    if (error) {
      console.error('Like error:', error);
      return res.json({ status: false, message: 'Failed to like message' });
    }

    res.json({
      status: true,
      data: updatedChat
    });
  } catch (error) {
    console.error('Like error:', error);
    res.json({ status: false, message: 'Failed to like message' });
  }
});

// Dislike a chat message
router.post('/dislike', async (req, res) => {
  try {
    const { chatID, userId } = req.body;
    if (!chatID || !userId) {
      return res.json({ status: false, message: 'chatID and userId are required' });
    }

    if (!isSupabaseAvailable()) {
      const msg = memoryStore.toggleChatReaction(chatID, userId, 'dislike');
      if (!msg) return res.json({ status: false, message: 'Message not found' });
      return res.json({ status: true, data: msg });
    }

    const supabase = getSupabase();

    const { data: chat } = await supabase
      .from('chat_messages')
      .select('*')
      .eq('id', chatID)
      .single();

    if (!chat) {
      return res.json({ status: false, message: 'Message not found' });
    }

    // Check if user already disliked
    if (chat.dislikes_ids?.includes(userId)) {
      return res.json({ status: false, message: 'Already disliked' });
    }

    // Remove like if exists
    let newLikesIds = chat.likes_ids || [];
    let newLikes = chat.likes;
    const likeIndex = newLikesIds.indexOf(userId);
    if (likeIndex > -1) {
      newLikesIds.splice(likeIndex, 1);
      newLikes--;
    }

    // Add dislike
    let newDislikesIds = chat.dislikes_ids || [];
    newDislikesIds.push(userId);
    const newDislikes = (chat.dislikes || 0) + 1;

    const { data: updatedChat, error } = await supabase
      .from('chat_messages')
      .update({
        likes: newLikes,
        likes_ids: newLikesIds,
        dislikes: newDislikes,
        dislikes_ids: newDislikesIds
      })
      .eq('id', chatID)
      .select()
      .single();

    if (error) {
      console.error('Dislike error:', error);
      return res.json({ status: false, message: 'Failed to dislike message' });
    }

    res.json({
      status: true,
      data: updatedChat
    });
  } catch (error) {
    console.error('Dislike error:', error);
    res.json({ status: false, message: 'Failed to dislike message' });
  }
});

module.exports = router;
