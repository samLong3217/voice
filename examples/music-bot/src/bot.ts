import Discord, { Interaction, GuildMember, Snowflake } from 'discord.js';
import {
	AudioPlayerStatus,
	AudioResource,
	entersState,
	joinVoiceChannel,
	VoiceConnectionStatus,
} from '@discordjs/voice';
import { Track } from './music/track';
import { MusicSubscription } from './music/subscription';
var axios = require('axios');

// eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
const { token } = require('../auth.json');

const client = new Discord.Client({ intents: ['GUILD_VOICE_STATES', 'GUILD_MESSAGES', 'GUILDS'] });

const youtubeKey = "AIzaSyCjvkLmBcLlIOojNfMTJtpKa0dP13fEDe8";


client.on('ready', () => console.log('Ready!'));

// This contains the setup code for creating slash commands in a guild. The owner of the bot can send "!deploy" to create them.
client.on('messageCreate', async (message) => {
	if (!message.guild) return;
	if (!client.application?.owner) await client.application?.fetch();

	if (message.content.toLowerCase() === '!deploy' && message.author.id === client.application?.owner?.id) {
		await message.guild.commands.set([
			{
				name: 'play',
				description: 'Plays a song',
				options: [
					{
						name: 'song',
						type: 'STRING' as const,
						description: 'The URL of the song to play',
						required: true,
					},
				],
			},
			{
				name: 'skip',
				description: 'Skip to the next song in the queue',
			},
			{
				name: 'queue',
				description: 'See the music queue',
			},
			{
				name: 'pause',
				description: 'Pauses the song that is currently playing',
			},
			{
				name: 'resume',
				description: 'Resume playback of the current song',
			},
			{
				name: 'leave',
				description: 'Leave the voice channel',
			},
		]);

		await message.reply('Deployed!');
	}
});

/**
 * Maps guild IDs to music subscriptions, which exist if the bot has an active VoiceConnection to the guild.
 */
const subscriptions = new Map<Snowflake, MusicSubscription>();

// Handles slash command interactions
client.on('interactionCreate', async (interaction: Interaction) => {
	if (!interaction.isCommand() || !interaction.guildId) return;
	let subscription = subscriptions.get(interaction.guildId);

	if (interaction.commandName === 'play') {
		//await interaction.defer();
		// Extract the video URL from the command

		let url = interaction.options.get('song')!.value! as string;
		let songList: string[] = []; // used for playlists
		if (!url.startsWith("http")) {
			await axios.get('https://www.googleapis.com/youtube/v3/search?key=' + youtubeKey + '&type=video&part=snippet&maxResults=1&q=' + url)
				.then((response: { data: { items: { id: { videoId: string; }; }[]; }; }) => {
					console.log("URL is = " + url);
					if (response.data.items.length == 0) {
						interaction.reply("Could not find a video called **" + url + "**, try **deez** instead. haha gotem");
						return;
					}
					url = "https://www.youtube.com/watch?v=" + response.data.items[0].id.videoId;
				});
			console.log(url);
		} else if (url.startsWith("https://www.youtube.com/playlist?list=")) {
			let playlistId = url.split("=")[1] as string;
			
			await axios.get('https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=500&playlistId=' + playlistId +'&key=' + youtubeKey)
				.then((response: { data: { items: { snippet: { resourceId: { videoId: string; }; }; }[]; }; }) => {
					if (response.data.items.length == 0) {
						interaction.reply("Could not find playlist: " + url);
						return;
					}
					
					response.data.items.forEach(item => {
						songList.push("https://www.youtube.com/watch?v=" + item.snippet.resourceId.videoId);
						
					});
				});
		}

		// If a connection to the guild doesn't already exist and the user is in a voice channel, join that channel
		// and create a subscription.
		if (!subscription) {
			if (interaction.member instanceof GuildMember && interaction.member.voice.channel) {
				const channel = interaction.member.voice.channel;
				subscription = new MusicSubscription(
					joinVoiceChannel({
						channelId: channel.id,
						guildId: channel.guild.id,
						adapterCreator: channel.guild.voiceAdapterCreator,
					}),
				);
				subscription.voiceConnection.on('error', console.warn);
				subscriptions.set(interaction.guildId, subscription);
			}
		}

		// If there is no subscription, tell the user they need to join a channel.
		if (!subscription) {
			await interaction.reply('Join a voice channel and then try that again!');
			return;
		}

		// Make sure the connection is ready before processing the user's request
		try {
			await entersState(subscription.voiceConnection, VoiceConnectionStatus.Ready, 20e3);
		} catch (error) {
			console.warn(error);
			await interaction.reply('Failed to join voice channel within 20 seconds, please try again later!');
			return;
		}

		try {
			if (songList.length == 0) {
				songList.push(url);
			}
			for (const songUrl of songList){
				// Attempt to create a Track from the user's video URL
				const track = await Track.from(songUrl, {
					onStart() {
						interaction.reply({ content: 'Now playing!', ephemeral: true }).catch(console.warn);
					},
					onFinish() {
						interaction.reply({ content: 'Now finished!', ephemeral: true }).catch(console.warn);
					},
					onError(error) {
						console.warn(error);
						interaction.reply({ content: `Error: ${error.message}`, ephemeral: true }).catch(console.warn);
					},
				}, interaction);
				// Enqueue the track and reply a success message to the user
				subscription.enqueue(track);
				if (songList.length == 1 && subscription.queue.length > 1) {
					interaction.channel?.send(` **${track.title}** added to queue`);
				}
			}
			if (songList.length > 1) {
				interaction.channel?.send(` **${songList.length}** songs added to queue`);
			}
			
		} catch (error) {
			console.warn(error);
			interaction.channel?.send('Failed to play track, please try again later!');
		}
	} else if (interaction.commandName === 'skip') {
		if (subscription) {
			// Calling .stop() on an AudioPlayer causes it to transition into the Idle state. Because of a state transition
			// listener defined in music/subscription.ts, transitions into the Idle state mean the next track from the queue
			// will be loaded and played.
			subscription.audioPlayer.stop();
			await interaction.reply('Skipped song!');
		} else {
			await interaction.reply('Not playing in this server!');
		}
	} else if (interaction.commandName === 'queue') {
		// Print out the current queue, including up to the next 5 tracks to be played.
		if (subscription) {
			const current =
				subscription.audioPlayer.state.status === AudioPlayerStatus.Idle
					? `Nothing is currently playing!`
					: `Playing **${(subscription.audioPlayer.state.resource as AudioResource<Track>).metadata.title}**`;

			const queue = subscription.queue
				.slice(0, 5)
				.map((track, index) => `${index + 1}) ${track.title}`)
				.join('\n');

			await interaction.reply(`${current}\n\n${queue}`);
		} else {
			await interaction.reply('Not playing in this server!');
		}
	} else if (interaction.commandName === 'pause') {
		if (subscription) {
			subscription.audioPlayer.pause();
			await interaction.reply({ content: `Paused!`, ephemeral: true });
		} else {
			await interaction.reply('Not playing in this server!');
		}
	} else if (interaction.commandName === 'resume') {
		if (subscription) {
			subscription.audioPlayer.unpause();
			await interaction.reply({ content: `Unpaused!`, ephemeral: true });
		} else {
			await interaction.reply('Not playing in this server!');
		}
	} else if (interaction.commandName === 'leave') {
		if (subscription) {
			subscription.voiceConnection.destroy();
			subscriptions.delete(interaction.guildId);
			await interaction.reply({ content: `Left channel!`, ephemeral: true });
		} else {
			await interaction.reply('Not playing in this server!');
		}
	} else {
		await interaction.reply('Unknown command');
	}
});

client.on('error', console.warn);

void client.login(token);
