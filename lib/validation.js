const assert = require('assert');
const slack = require('@slack/web-api');
const contests = require('../contests');
const langInfos = require('../data/infos.json');
const langs = require('../data/langs.json');
const docker = require('../engines/docker');
const Language = require('../models/Language');
const Submission = require('../models/Submission');
const discord = require('./discord');
const ptrace = require('./ptrace');
const io = require('./socket-io');

const slackClient = new slack.WebClient(process.env.SLACK_TOKEN);

const markError = (submission, error) => {
	console.error(error);
	submission.status = 'error';
	submission.error.name = error.name;
	submission.error.stack = error.stack;
	submission.save();
};

const isValidTrace = (language, trace) => {
	if (trace === null) {
		return true;
	}

	if (['bash-busybox', 'm4', 'cmd'].includes(language)) {
		return true;
	}

	const langInfo = langInfos.find(({slug}) => slug === language);
	if (!langInfo || !langInfo.execs) {
		return true;
	}

    const execs = ptrace.parse(trace.toString());
    // Only count after running /root/code.
    // Nim: Nim compiles several times when the source code contains "import", but this
    // violates trace validation.
    if (['nim-lang'].includes(language)) {
        const codefunc = execname => execname === "/root/code";
        const execsRootCodeIndex = execs.findIndex(codefunc);
        const infoRootCodeIndex = langInfo.execs.findIndex(codefunc);
        if (infoRootCodeIndex < 0 || execsRootCodeIndex < 0) {
            console.log("Nim: No /root/code in trace. EXEC VALIDATION IS CRACKED");
            console.log(execs);
            return execs.length <= langInfo.execs.length;
        }
        const execsAfterRootCode =  execs.slice(execsRootCodeIndex);
        const infoExecsAfterRootCode = langInfo.execs.slice(infoRootCodeIndex);
        return execsAfterRootCode.length <= infoExecsAfterRootCode.length;
    }
    return execs.length <= langInfo.execs.length;
}

module.exports.isValidTrace = isValidTrace;

module.exports.validate = async ({
	submission,
	language,
	solution,
	contest,
	noInputGeneration = false,
}) => {
	try {
		assert({}.hasOwnProperty.call(contests, contest.id));
		const {generateInput, isValidAnswer} = contests[contest.id];

                const submissionInput = ["", ""];
		if (!noInputGeneration) {
			submissionInput[0] = generateInput();
			submissionInput[1] = generateInput();
		}
		const newSubmission = await submission.save();

const istraced = [false, true];

		console.log('info:', newSubmission.code);
                for (let i = 0;i<2;i++) {
var info = await docker({
			id: language.slug,
			code: newSubmission.code,
			stdin: submissionInput[i],
			trace: istraced[i],
			disasm: false,
		});
                   var {stdout, stderr, duration, error, trace} = info;
                   newSubmission.stdout = stdout;
                   newSubmission.stderr = stderr;
                   newSubmission.duration = duration;
                   newSubmission.trace = trace;

                   newSubmission.input = submissionInput[i];

                   if (error) {
                           await newSubmission.save();
info = null;
stdout = null;
stderr = null;
duration = null;
error = null;
trace = null;
                           throw error;
                   }
                   if (!isValidTrace(language.slug, trace)) {
                           newSubmission.status = 'invalid';
                           await newSubmission.save();
info = null;
stdout = null;
stderr = null;
duration = null;
error = null;
trace = null;
                           return;
                   }

                   if (isValidAnswer(submissionInput[i], stdout)) {
                           newSubmission.status = 'success';

                   } else {
                           newSubmission.status = 'failed';
                   }

                   // break if validation #0 (i = 0) does not success
                   if (newSubmission.status !== 'success') {
                      console.log(`Validation #${i} failed.`);
info = null;
stdout = null;
stderr = null;
duration = null;
error = null;
trace = null;
                      break;
                   }
info = null;
stdout = null;
stderr = null;
duration = null;
error = null;
trace = null;
                }

           const isOverTimed = contest.isOverTime();

           // you should success both checks
           if (newSubmission.status === 'success' && !isOverTimed) {
                           Language.updateOne(
                                   {slug: language.slug, contest},
                                   {$set: {solution: newSubmission._id}},
                           ).then(() => {
                                   io.emit('update-languages', {});
                           });
           }

		const savedSubmission = await newSubmission.save();
		const populatedSubmission = await Submission.populate(savedSubmission, {
			path: 'user language',
		});

		if (populatedSubmission.status === 'success') {
			const bytesInfo = (() => {
				if (solution) {
					return `${
						[
							':heart:',
							':blue_heart:',
							':green_heart:',
							':yellow_heart:',
							':purple_heart:',
						][solution.user.getTeam(contest)]
					} **${solution.size} bytes** => ${
						[
							':heart:',
							':blue_heart:',
							':green_heart:',
							':yellow_heart:',
							':purple_heart:',
						][populatedSubmission.user.getTeam(contest)]
					} **${populatedSubmission.size} bytes**`;
				}

				return `:new: ${
					[
						':heart:',
						':blue_heart:',
						':green_heart:',
						':yellow_heart:',
						':purple_heart:',
					][populatedSubmission.user.getTeam(contest)]
				} **${populatedSubmission.size} bytes**`;
			})();

			try {
				discord.send(
					`**${populatedSubmission.user.name()}** won the language **${
						language.name
					}**!! (${bytesInfo}) Congrats!!!\n${
						process.env.SERVER_ORIGIN
                                        }/submissions/${
						populatedSubmission._id
					}`,
				);
				await slackClient.chat.postMessage({
					channel: process.env.SLACK_CHANNEL,
					icon_emoji: ':tada:',
					username: 'esolang-battle',
					text: `*${populatedSubmission.user.name()}* won the language *${
						language.name
					}**!! (${bytesInfo}) Congrats!!!\n${
						process.env.SERVER_ORIGIN
                                        }/submissions/${
						populatedSubmission._id
					}`,
				});
			} catch (e) {
				console.error(e);
			}
		}
	} catch (error) {
		markError(submission, error);
	} finally {
		io.emit('update-submission', {_id: submission._id});

		// disasm

		const lang = langs.find(({slug}) => slug === language.slug);
		if (lang && lang.disasm) {
			const disasmInfo = await docker({
				id: language.slug,
				code: submission.code,
				stdin: '',
				trace: false,
				disasm: true,
			});
			console.log('disasm info:', disasmInfo);

			const result = await Submission.updateOne(
				{_id: submission._id},
				{$set: {disasm: disasmInfo.stdout}},
			);
			console.log({result});
		}
	}
};
