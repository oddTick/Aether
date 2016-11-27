const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const User = require('./models/User');
const Group = require('./models/Group');
const Message = require('./models/Message');
const conf = require('./conf');

// 在线用户
const onlineUsers = (() => {
  const users = [];
  return {
    addUser(socket, user) {
      socket.username = user.username;
      socket.groups = [];
      for (const group of user.groups) {
        socket.groups.push(group.groupName);
        socket.join(group.groupName);
      }
      users.push(socket);
      console.log(`用户登录: ${socket.username}`);
      console.log(`当前在线用户数量: ${users.length}`);
    },
    removeUser(socket) {
      if (users.includes(socket)) {
        for (const group of socket.groups) {
          socket.leave(group);
        }
        const index = users.indexOf(socket);
        users.splice(index, 1);
        console.log(`用户登出: ${socket.username}`);
        console.log(`当前在线用户数量: ${users.length}`);
        delete socket.username;
        delete socket.groups;
      }
    },
    joinGroup(socket, groupName) {
      socket.groups.push(groupName);
      socket.join(groupName);
    },
    leaveGroup(socket, groupName) {
      const index = socket.groups.indexOf(groupName);
      socket.groups.splice(index, 1);
      socket.leave(groupName);
    },
    findUser(username) {
      for (const user of users) {
        if (user.username === username) {
          return user;
        }
      }
    },
  };
})();

module.exports = function socketHandler(socket) {
  /* 首次启动创建主群 */
  Group.getSimpleData('Aether').then((Aether) => {
    if (!Aether) {
      new Group({
        groupName: 'Aether',
        avatar: conf.AVATAR,
      }).save();
    }
  });
  /* 用户注册 */
  socket.on('signup', async ({ username, password }, cb) => {
    try {
      let user = await User.getSimpleInfo(username);
      if (user) {
        cb({
          success: false,
          code: 3,
        });
      } else {
        const mainGroup = await Group.getFullData('Aether');
        user = await new User({
          username,
          password,
          groups: [mainGroup],
        }).save();
        user = user.toObject();
        const token = jwt.sign({ username }, 'Aether', { expiresIn: '3d' });
        onlineUsers.addUser(socket, user);
        const groups = user.groups;
        delete user.groups;
        cb({
          success: true,
          token,
          user,
          groups,
        });
      }
    } catch (err) { console.log(err); }
  });
  /* 前端使用token登录 */
  socket.on('loginWithToken', async (token, cb) => {
    try {
      const username = jwt.verify(token, 'Aether').username;
      let user = await User.getFullInfo(username);
      if (user) {
        user = user.toObject();
        onlineUsers.addUser(socket, user);
        const groups = user.groups;
        delete user.groups;
        delete user.password;
        cb({
          success: true,
          user,
          groups,
        });
      } else {
        cb({ success: false });
      }
    } catch (err) {
      cb({ success: false });
    }
  });
  /* 前端用户名和密码登录 */
  socket.on('login', async ({ username, password }, cb) => {
    try {
      let user = await User.getFullInfo(username);
      if (user) {
        user = user.toObject();
        if (user.password === password) {
          onlineUsers.addUser(socket, user);
          const groups = user.groups;
          delete user.groups;
          const token = jwt.sign({ username }, 'Aether', { expiresIn: '3d' });
          cb({
            success: true,
            token,
            user,
            groups,
          });
        } else {
          cb({
            success: false,
            code: 1,
          });
        }
      } else {
        cb({
          success: false,
          code: 2,
        });
      }
    } catch (err) { console.log(err); }
  });
  /* 消息推送 */
  socket.on('message', async (message) => {
    try {
      const username = socket.username;
      const user = await User.getSimpleInfo(username);
      message.user = {
        username,
        avatar: user.avatar,
      };
      const groupName = message.groupName;
      const match = groupName.match(/(.*)&&(.*)/);
      // 私聊消息
      if (match) {
        const anotherUser = username === match[1] ? match[2] : match[1];
        const userSocket = onlineUsers.findUser(anotherUser);
        if (userSocket && !userSocket.groups.includes(groupName)) {
          onlineUsers.joinGroup(userSocket, groupName);
        }
      }
      socket.broadcast.to(groupName).emit('message', message);
      if (match) {
        return;
      }
      delete message.groupName;
      message.user = user;
      const newMessage = await new Message(message).save();
      const group = await Group.getSimpleData(groupName);
      group.messages.push(newMessage);
      group.save();
    } catch (e) { console.log(e); }
  });
  /* 用户登出 */
  socket.on('logout', () => {
    onlineUsers.removeUser(socket);
  });
  /* 用户断开连接 */
  socket.on('disconnect', () => {
    onlineUsers.removeUser(socket);
  });
  /* 推送历史消息 */
  socket.on('getHistoryMessages', async ({ groupName, skip }, cb) => {
    try {
      const group = await Group.getMessages(groupName, skip);
      const messages = group.messages;
      console.log(messages.length);
      if (messages.length) {
        cb({
          success: true,
          messages,
        });
      } else {
        cb({ success: false });
      }
    } catch (e) { console.log(e); }
  });
  /* 改变用户数据 */
  socket.on('changeUserInfo', async (newData) => {
    try {
      const user = await User.getSimpleInfo(socket.username);
      for (const key of Object.keys(newData)) {
        user[key] = newData[key];
      }
      user.save();
    } catch (e) { /* console.log(e); */ }
  });
  /* 生成并返回云存储上传token */
  socket.on('getUploadToken', (cb) => {
    const putPolicy = JSON.stringify({
      scope: conf.BUCKET,
      deadline: parseInt(Date.now() / 1000) + conf.EXPIRED_SECONDS,
    });
    const encodedPutPolicy = new Buffer(putPolicy).toString('base64');
    const encodedSign = crypto.createHmac('sha1', conf.SECRET_KEY)
    .update(encodedPutPolicy)
    .digest()
    .toString('base64');
    const token = `${conf.ACCESS_KEY}:${encodedSign}:${encodedPutPolicy}`;
    cb(token);
  });
  /* 创建或加入群组 */
  socket.on('joinGroup', async (groupName, cb) => {
    try {
      const user = await User.getSimpleInfo(socket.username);
      let group = await Group.getFullData(groupName);
      if (!group) {
        group = await new Group({ groupName }).save();
      }
      user.groups.push(group);
      user.save();
      onlineUsers.joinGroup(socket, groupName);
      group.messages = group.messages.slice(0,30);
      cb(group);
    } catch (e) { /* console.log(e); */ }
  });
  /* 离开群组 */
  socket.on('leaveGroup', async (groupName) => {
    try {
      const user = await User.getSimpleInfo(socket.username);
      user.groups = user.groups.filter(group => group.groupName !== groupName);
      user.save();
      onlineUsers.leaveGroup(socket, groupName);
    } catch (e) { /* console.log(e); */ }
  });
  /* 获取用户信息(点击卡片时) */
  socket.on('getUserInfo', async (username, cb) => {
    try {
      const user = await User.getSimpleInfo(username);
      const { sign, location } = user;
      cb({
        username,
        sign,
        location,
      });
    } catch (e) { /* console.log(e); */ }
  });
  /* 发起私聊（私聊消息不存储） */
  socket.on('launchChat', async (groupName) => {
    onlineUsers.joinGroup(socket, groupName);
  });
};
