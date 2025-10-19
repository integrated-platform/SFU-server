import express from 'express';
import http from 'http';
import { Server, Socket } from 'socket.io';
import { Kafka } from 'kafkajs';

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// -------------------------------
// Kafka 설정
// -------------------------------
const kafka = new Kafka({
  clientId: 'sfu-server',
  brokers: process.env.KAFKA_BROKERS?.split(',') || ['localhost:9092'],
});
const kafkaConsumer = kafka.consumer({ groupId: 'sfu-group' });
const kafkaProducer = kafka.producer();

(async () => {
  await kafkaConsumer.connect();
  await kafkaProducer.connect();
  await kafkaConsumer.subscribe({ topic: 'sfu_commands', fromBeginning: false });

  await kafkaConsumer.run({
    eachMessage: async ({ message }) => {
      if (!message.value) return;
      const command = JSON.parse(message.value.toString());
      handleCommand(command);
    },
  });

  console.log('✅ SFU Kafka consumer running');
})();

// -------------------------------
// 방/참가자 관리
// -------------------------------
interface RoomUser {
  socketId: string;
  environmentReady: boolean;
}

const roomUsers: Record<string, RoomUser[]> = {}; // roomId → RoomUser[]

const handleCommand = (command: any) => {
  switch (command.type) {
    case 'joinRoom':
      console.log(`SFU: ${command.user.userName} joined room ${command.roomId}`);
      io.in(command.roomId).emit('user-joined', command);
      break;
    case 'disconnect':
      io.emit('user-disconnected', { socketId: command.socketId });
      break;
    default:
      console.log('SFU: Unknown command', command);
  }
};

// -------------------------------
// Socket.IO 연결
// -------------------------------
io.on('connection', (socket: Socket) => {
  console.log('SFU connected:', socket.id);

  // -------------------------------
  // WebRTC relay
  // -------------------------------
  socket.on('relay-offer', (data) =>
    socket.to(data.room).emit('relay-offer', { sender: socket.id, offer: data.offer }),
  );
  socket.on('relay-answer', (data) =>
    socket.to(data.room).emit('relay-answer', { sender: socket.id, answer: data.answer }),
  );
  socket.on('relay-candidate', (data) =>
    socket.to(data.room).emit('relay-candidate', { sender: socket.id, candidate: data.candidate }),
  );

  // -------------------------------
  // 환경 구성 완료
  // -------------------------------
  socket.on('environment-ready', async (data: { roomId: string }) => {
    const { roomId } = data;
    if (!roomUsers[roomId]) roomUsers[roomId] = [];
    let user = roomUsers[roomId].find((u) => u.socketId === socket.id);
    if (!user) {
      user = { socketId: socket.id, environmentReady: true };
      roomUsers[roomId].push(user);
    } else {
      user.environmentReady = true;
    }

    // 참가자 목록 브로드캐스트
    io.in(roomId).emit('update-room-users', { users: roomUsers[roomId] });

    // Kafka 피드백 전송
    try {
      await kafkaProducer.send({
        topic: 'sfu_feedback',
        messages: [
          {
            value: JSON.stringify({
              event: 'environment-ready',
              roomId,
              socketId: socket.id,
            }),
          },
        ],
      });
    } catch (err) {
      console.error('Kafka feedback send failed:', err);
    }
  });

  // -------------------------------
  // Socket disconnect
  // -------------------------------
  socket.on('disconnect', () => {
    console.log('SFU disconnected:', socket.id);
    // 모든 방에서 제거
    for (const roomId in roomUsers) {
      roomUsers[roomId] = roomUsers[roomId].filter((u) => u.socketId !== socket.id);
      io.in(roomId).emit('update-room-users', { users: roomUsers[roomId] });
      if (roomUsers[roomId].length === 0) delete roomUsers[roomId];
    }
  });
});



// -------------------------------
// 서버 실행
// -------------------------------
server.listen(process.env.SFU_PORT || 8500, () => console.log(`🚀 SFU 서버 실행 중`));
